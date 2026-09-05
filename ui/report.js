import { renderReport } from "../lib/report.js";
import { localDay } from "../lib/store.js";

const $ = (s) => document.querySelector(s);

const errors = [];
function reportError(where, err) {
  errors.push(`${new Date().toLocaleTimeString()}  ${where}: ${err?.message || err}`);
  const box = $("#errbox");
  if (box) {
    box.hidden = false;
    box.textContent = "Something went wrong — please send this to Claude:\n\n" + errors.join("\n");
  }
  try { browser.storage.local.set({ reportErrors: errors.slice(-20) }); } catch { /* nothing to do */ }
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
  wire();
}

// Agree / Wrong is the feedback signal the shadow run measures precision from.
// "Wrong" runs exactly the same learning path as physically moving a message back.
function wire() {
  const tog = document.querySelector("#hidedone");
  if (tog) tog.addEventListener("change", () => {
    hideReviewed = tog.checked;
    localStorage.setItem("hideReviewed", hideReviewed ? "1" : "0");
    draw();
  });

  for (const btn of document.querySelectorAll(".btns button")) {
    btn.addEventListener("click", async () => {
      const cell = btn.closest(".btns");
      const hmid = cell.dataset.hmid;
      const act = btn.dataset.act;
      cell.innerHTML = '<span class="done">saving…</span>';
      const found = await browser.messages.query({ headerMessageId: hmid });
      const m = found.messages[0];
      if (act === "confirm") {
        // Changing "trusted" back to "agreed" must also withdraw the allow-list entry.
        if (m) await browser.runtime.sendMessage({ cmd: "markSpam", id: m.id, headerMessageId: hmid });
        else await browser.runtime.sendMessage({ cmd: "confirm", headerMessageId: hmid });
        cell.innerHTML = '<span class="done">✓ agreed</span>' +
          ' <button class="chg" data-act="wrong">change</button>';
      } else {
        if (m) await browser.runtime.sendMessage({ cmd: "trustSender", id: m.id, headerMessageId: hmid });
        cell.innerHTML = '<span class="done">✓ sender trusted</span>' +
          ' <button class="chg" data-act="confirm">change</button>';
      }
      wire();
      const tr = cell.closest("tr");
      tr.classList.replace("pending", "reviewed");
      if (hideReviewed && !btn.classList.contains("chg")) setTimeout(() => tr.remove(), 400);
      bumpCounts();
    });
  }
}

// ---- live progress -----------------------------------------------------
// The background script broadcasts one message per classified email. Without this
// a long batch looks like the add-on has hung.

const live = {
  show(on) { $("#live").hidden = !on; },
  reset(total) {
    $("#stop").hidden = false;
    this.total = total; this.done = 0;
    $("#livefill").style.width = "0%";
    $("#livecount").textContent = `0 of ${total}`;
    $("#livetally").innerHTML = "";
    $("#livenow").textContent = "loading model…";
    this.show(true);
  },
  item(m) {
    this.done = m.done;
    const pct = m.total ? (m.done / m.total) * 100 : 0;
    $("#livefill").style.width = pct.toFixed(1) + "%";
    $("#livecount").textContent = `${m.done} of ${m.total}`;
    const c = m.counts || {};
    const pills = [];
    if (c.business_spam) pills.push(`<span class="pill spam">${c.business_spam} business spam</span>`);
    if (c.phishing)      pills.push(`<span class="pill phish">${c.phishing} phishing</span>`);
    if (c.legitimate)    pills.push(`<span class="pill legit">${c.legitimate} legitimate</span>`);
    if (c.allowlisted)   pills.push(`<span class="pill trust">${c.allowlisted} trusted</span>`);
    if (c.failed)        pills.push(`<span class="pill fail">${c.failed} failed</span>`);
    $("#livetally").innerHTML = pills.join("");
    $("#livenow").textContent = m.subject ? `${m.category} — ${m.subject}` : "";
  },
  done(m) {
    $("#stop").hidden = true;
    $("#livefill").style.width = "100%";
    if (m.skipped) {
      $("#livenow").textContent = m.skipped === "ollama-down"
        ? "Ollama is not reachable — nothing was lost, the queue is intact."
        : m.skipped === "model-missing" ? "The configured model is not pulled."
        : m.skipped;
      return;
    }
    $("#livenow").textContent = m.gpuReleased
      ? "finished — model unloaded, GPU released"
      : "finished";
    setTimeout(() => this.show(false), 6000);
    // Always refresh. Rows render their stored verdict, so a redraw no longer
    // discards work in progress, and results that never appear are worse than a
    // table that moves under you.
    draw();
  },
};

browser.runtime.onMessage.addListener((m) => {
  if (m.evt === "start") live.reset(m.total);
  else if (m.evt === "item") live.item(m);
  else if (m.evt === "done") live.done(m);
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
