// Correcting a verdict from the message itself, which is where you notice the
// mistake — rather than having to find it again in a report.

const $ = (s) => document.querySelector(s);

const BADGE = {
  business_spam: '<span class="b spam">business spam</span>',
  phishing: '<span class="b phish">possible phishing</span>',
  legitimate: '<span class="b legit">legitimate</span>',
};

let msg = null;

async function init() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  msg = await browser.messageDisplay.getDisplayedMessage(tabs[0].id);
  if (!msg) { $("#cur").textContent = "No message selected."; return; }

  const info = await browser.runtime.sendMessage({
    cmd: "verdictFor", headerMessageId: msg.headerMessageId });

  if (info?.verdict) {
    const v = info.verdict;
    $("#cur").innerHTML =
      `<div class="cat">${BADGE[v.category] || v.category}` +
      `${v.userVerdict ? ` <span style="color:var(--mut);font-weight:400">· you marked this ${
         v.userVerdict === "agree" ? "correct" : "wrong"}</span>` : ""}</div>` +
      `<div class="why">${escapeHtml(v.reason || "")}</div>`;
  } else {
    $("#cur").innerHTML = '<div class="cat">Not classified yet</div>' +
      '<div class="why">You can still teach it about this sender.</div>';
  }

  if (info?.keys?.length) {
    $("#key").innerHTML = `Trusting would allow-list <code>${escapeHtml(info.keys[0])}</code>`;
  }
  $("#actions").hidden = false;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function finish(text) {
  $("#actions").hidden = true;
  $("#key").textContent = "";
  $("#done").hidden = false;
  $("#done").textContent = text;
  setTimeout(() => window.close(), 1600);
}

$("#trust").addEventListener("click", async () => {
  const r = await browser.runtime.sendMessage({
    cmd: "trustSender", id: msg.id, headerMessageId: msg.headerMessageId });
  finish(r?.key ? `Trusted ${r.key}` : "Sender trusted");
});

$("#spam").addEventListener("click", async () => {
  await browser.runtime.sendMessage({
    cmd: "markSpam", id: msg.id, headerMessageId: msg.headerMessageId });
  finish("Recorded as spam");
});

init();
