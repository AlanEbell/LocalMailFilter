import { renderReport } from "../lib/report.js";

const $ = (s) => document.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
const status = (t) => { $("#status").textContent = t; };

async function draw() {
  const day = $("#day").value || today();
  $("#out").innerHTML = await renderReport(day, { interactive: true });
  wire();
}

// Agree / Wrong is the feedback signal the shadow run measures precision from.
// "Wrong" runs exactly the same learning path as physically moving a message back.
function wire() {
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
    });
  }
}

$("#day").value = today();
$("#day").addEventListener("change", draw);
$("#sort").addEventListener("click", async () => {
  status("classifying…");
  const r = await browser.runtime.sendMessage({ cmd: "sortNow" });
  status(r.skipped === "ollama-down" ? "Ollama is not running."
       : r.skipped === "empty" ? "Nothing queued."
       : `processed ${r.processed}`);
  draw();
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
