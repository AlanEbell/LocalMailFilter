import { renderReport } from "../lib/report.js";

const $ = (s) => document.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
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
      if (act === "confirm") {
        await browser.runtime.sendMessage({ cmd: "confirm", headerMessageId: hmid });
        cell.innerHTML = '<span class="done">✓ agreed</span>';
      } else {
        const found = await browser.messages.query({ headerMessageId: hmid });
        const m = found.messages[0];
        if (m) await browser.runtime.sendMessage({ cmd: "rescue", id: m.id, headerMessageId: hmid });
        cell.innerHTML = '<span class="done">✓ sender trusted</span>';
      }
      const tr = cell.closest("tr");
      tr.classList.replace("pending", "reviewed");
      if (hideReviewed) setTimeout(() => tr.remove(), 400);
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
    // Only redraw if nothing is part-way through being reviewed, so a batch
    // completing does not yank the table out from under you.
    if (!document.querySelector("tr.pending")) draw();
    else status("new results ready — reload the day to see them");
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

$("#day").value = today();
$("#day").addEventListener("change", draw);
$("#sort").addEventListener("click", async () => {
  status("");
  const r = await browser.runtime.sendMessage({ cmd: "sortNow" });
  if (r.skipped === "empty") status("Nothing queued — try Scan last 24h.");
  else if (r.skipped === "already-running") status("Already running.");
});
$("#scan").addEventListener("click", async () => {
  status("scanning inboxes…");
  const r = await browser.runtime.sendMessage({ cmd: "scanInbox", days: 1 });
  status(`queued ${r.queued}`); setTimeout(draw, 2000);
});
$("#recon").addEventListener("click", async () => {
  status("checking…");
  const n = await browser.runtime.sendMessage({ cmd: "reconcile" });
  status(`learned from ${n} off-device rescue(s)`); draw();
});
$("#opts").addEventListener("click", () => browser.runtime.openOptionsPage());
draw();
