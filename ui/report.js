import { renderReport } from "../lib/report.js";
import { localDay } from "../lib/store.js";

const $ = (s) => document.querySelector(s);

// Two writers, two keys. The background page records its own failures under
// backgroundErrors; sharing one key would have each overwrite the other's history.
const errors = [];
let bgErrors = [];

function renderErrBox() {
  const box = $("#errbox");
  if (!box) return;
  const parts = [];
  if (bgErrors.length)
    parts.push("Background failures (the daily report runs unattended):\n" + bgErrors.join("\n"));
  if (errors.length) parts.push("This page:\n" + errors.join("\n"));
  if (!parts.length) return;
  box.hidden = false;
  box.textContent = "Something went wrong — please send this to Claude:\n\n" + parts.join("\n\n");
}

function reportError(where, err) {
  errors.push(`${new Date().toLocaleTimeString()}  ${where}: ${err?.message || err}`);
  renderErrBox();
  try { browser.storage.local.set({ reportErrors: errors.slice(-20) }); } catch { /* nothing to do */ }
}

// A failed daily report leaves no other trace: it happens while this page is closed.
async function loadBackgroundErrors() {
  try {
    const { backgroundErrors = [] } = await browser.storage.local.get("backgroundErrors");
    bgErrors = backgroundErrors;
    renderErrBox();
  } catch { /* nothing to do */ }
}
window.addEventListener("error", (e) => reportError("uncaught", e.error || e));
window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));

function on(sel, fn) {
  const el = $(sel);
  if (!el) { reportError("wiring", new Error(`element ${sel} not found`)); return; }
  el.addEventListener("click", async (ev) => {
    try { await fn(ev); } catch (err) { reportError(sel, err); }
  });
}
const today = () => localDay();
const status = (t) => { $("#status").textContent = t; };

let hideReviewed = localStorage.getItem("hideReviewed") !== "0";

async function draw() {
  const day = $("#day").value || today();
  $("#out").innerHTML = await renderReport(day, { interactive: true, hideReviewed });
}

// Agree / Wrong is the feedback signal the shadow run measures precision from.
// "Wrong" runs exactly the same learning path as physically moving a message back.
//
// One delegated listener on the container, attached once. Re-attaching per-button
// listeners after every click stacked duplicates: the first replaced the cell's
// innerHTML, detaching the button, and the duplicates then fired on a detached node
// where closest(".btns") is null. It also meant a single click sent the verdict
// several times.
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("#out .btns button");
  if (!btn) return;
  const cell = btn.closest(".btns");
  if (!cell) return;                       // already replaced by an earlier handler

  const hmid = cell.dataset.hmid;
  const act = btn.dataset.act;
  const isChange = btn.classList.contains("chg");
  if (!hmid || !act) return;

  cell.innerHTML = '<span class="done">saving…</span>';
  try {
    const found = await browser.messages.query({ headerMessageId: hmid });
    const m = found.messages[0];
    if (act === "confirm") {
      // Agreeing records agreement and nothing else. It must not re-classify the
      // message or log a correction: the model was right, so there is nothing to learn.
      await browser.runtime.sendMessage({ cmd: "confirm", headerMessageId: hmid });
      cell.innerHTML = '<span class="done">\u2713 agreed</span>' +
        ' <button class="chg" data-act="wrong">change</button>';
    } else if (act === "allow") {
      // The verdict was right and stays recorded as right; the sender is allow-listed
      // so it stops being filed, and nothing is taught to the model.
      if (m) await browser.runtime.sendMessage({ cmd: "allowAnyway", id: m.id, headerMessageId: hmid });
      else await browser.runtime.sendMessage({ cmd: "confirm", headerMessageId: hmid });
      cell.innerHTML = '<span class="done">\u2713 right, but allowed</span>' +
        ' <button class="chg" data-act="untrust">change</button>';
    } else if (act === "untrust") {
      // Reversing a trust: withdraw the allow-list entry it created.
      if (m) await browser.runtime.sendMessage({ cmd: "markSpam", id: m.id, headerMessageId: hmid });
      else await browser.runtime.sendMessage({ cmd: "confirm", headerMessageId: hmid });
      cell.innerHTML = '<span class="done">\u2713 agreed</span>' +
        ' <button class="chg" data-act="wrong">change</button>';
    } else {
      if (m) await browser.runtime.sendMessage({ cmd: "trustSender", id: m.id, headerMessageId: hmid });
      else await browser.runtime.sendMessage({ cmd: "confirm", headerMessageId: hmid });
      cell.innerHTML = '<span class="done">\u2713 sender trusted</span>' +
        ' <button class="chg" data-act="confirm">change</button>';
    }
    const tr = cell.closest("tr");
    if (tr) {
      tr.classList.remove("pending");
      tr.classList.add("reviewed");
      if (hideReviewed && !isChange) setTimeout(() => tr.remove(), 400);
    }
    bumpCounts();
  } catch (err) {
    cell.innerHTML = '<span class="done">failed</span>';
    reportError("verdict", err);
  }
});

// The hide-reviewed toggle is re-rendered with the table, so it is delegated too.
document.addEventListener("change", (ev) => {
  if (ev.target.id !== "hidedone") return;
  hideReviewed = ev.target.checked;
  localStorage.setItem("hideReviewed", hideReviewed ? "1" : "0");
  draw();
});

// Keep the "N reviewed, M left" line honest as you click, without a full redraw.
function bumpCounts() {
  const bar = document.querySelector(".revbar");
  if (!bar) return;
  const done = document.querySelectorAll("tr.reviewed").length;
  const left = document.querySelectorAll("tr.pending").length;
  const strongs = bar.querySelectorAll("strong");
  if (strongs[0]) strongs[0].textContent = done;
  if (strongs[1]) strongs[1].textContent = left;
}

$("#ver").textContent = "v" + browser.runtime.getManifest().version;
$("#day").value = today();
$("#day").addEventListener("change", draw);
on("#sort", async () => {
  status("");
  const r = await browser.runtime.sendMessage({ cmd: "sortNow" });
  if (r.skipped === "empty") status("Nothing queued — try Scan last 24h.");
  else if (r.skipped === "already-running") status("Already running.");
});
on("#scan", async () => {
  const days = Number($("#scanrange").value);
  status("counting…");

  // Say what it will cost before spending hours of GPU time on it.
  const probe = await browser.runtime.sendMessage({ cmd: "scanInbox", days, dryRun: true });
  if (!probe.pending) {
    status(`nothing new — all ${probe.scanned} message(s) in range already classified`);
    return;
  }
  const mins = probe.estimateMinutes;
  const pretty = mins >= 60 ? `about ${(mins / 60).toFixed(1)} hours` : `about ${mins} minute(s)`;
  const ok = confirm(
    `${probe.pending} unclassified message(s) found out of ${probe.scanned} in range.\n\n` +
    `This will take ${pretty} of continuous GPU work.\n\n` +
    `You can stop at any time and nothing already done is lost. Start now?`);
  if (!ok) { status("cancelled"); return; }

  const r = await browser.runtime.sendMessage({ cmd: "scanInbox", days });
  status(`queued ${r.queued} — classifying…`);
  draw();
});

on("#stop", async () => {
  await browser.runtime.sendMessage({ cmd: "stopDrain" });
  status("stopping after the current message…");
});
on("#recon", async () => {
  status("checking…");
  const n = await browser.runtime.sendMessage({ cmd: "reconcile" });
  status(`learned from ${n} off-device rescue(s)`); draw();
});
on("#opts", () => browser.runtime.openOptionsPage());
on("#refresh", () => draw());

draw().catch((e) => reportError("draw", e));
loadBackgroundErrors();
