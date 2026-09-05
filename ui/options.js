import { getSettings, setSettings, stats, exportAll, importAll } from "../lib/store.js";
import { getAllow, revoke } from "../lib/allowlist.js";
import { buildOwnerBlock, suggestNotes } from "../lib/owner.js";

const $ = (s) => document.querySelector(s);
const FIELDS = ["mode","endpoint","model","bodyChars","folderName","reportEmail","reportHour","ownerNotes"];
const CHECKS = ["emailReport","notifyOnSort"];

async function load() {
  const s = await getSettings();

  const mf = browser.runtime.getManifest();
  $("#ver").textContent = "v" + mf.version;
  // A single line answering "what am I actually running, and against what?" —
  // the questions worth asking first when something looks wrong.
  $("#foot").innerHTML =
    `<span>Mail Triage <strong>v${mf.version}</strong></span>` +
    `<span>Thunderbird ${navigator.userAgent.match(/Thunderbird\/([\d.]+)/)?.[1] || "?"}</span>` +
    `<span>model <strong>${s.model}</strong> at ${s.endpoint}</span>` +
    `<span><a href="https://github.com/AlanEbell/LocalMailFilter" target="_blank">source</a></span>`;
  for (const f of FIELDS) $("#" + f).value = s[f];

  // Nothing here should ask for something Thunderbird already knows. Default the
  // report recipient to the default account's own address.
  if (!s.reportEmail) {
    const accts = await browser.accounts.list(false);
    const first = accts.flatMap((a) => a.identities || []).find((i) => i.email);
    if (first) $("#reportEmail").value = first.email;
  }
  for (const c of CHECKS) $("#" + c).checked = !!s[c];

  const accts = (await browser.accounts.list(false)).filter((a) => a.type === "imap" || a.type === "pop3");
  $("#accounts").innerHTML = accts.map((a) => {
    const on = !s.watchedAccounts.length || s.watchedAccounts.includes(a.id);
    return `<div><label><input type="checkbox" class="acct" value="${a.id}" ${on ? "checked" : ""}> ${a.name}</label></div>`;
  }).join("") + `<div class="hint">Unchecking all is treated as "watch all".</div>`;

  $("#derived").textContent = await buildOwnerBlock("");

  browser.runtime.sendMessage({ cmd: "folders" }).then((fs) => {
    $("#folders").innerHTML = (fs || []).map((f) =>
      f.ok ? `<div><span class="ok">✓</span> ${f.account} <code>${f.path || ""}</code></div>`
           : `<div><span class="bad">✗</span> ${f.account} — no folder; tag-only</div>`
    ).join("") || '<span class="hint">no accounts watched</span>';
  });

  const st = await stats();
  const pct = st.precision === null ? "—" : (st.precision * 100).toFixed(1) + "%";
  $("#stats").innerHTML = `
    <div><b>${st.flagged}</b><span>flagged all-time</span></div>
    <div><b>${st.reviewed}</b><span>you reviewed</span></div>
    <div><b>${st.wrong}</b><span>false positives</span></div>
    <div><b>${pct}</b><span>precision</span></div>`;

  const ready = st.reviewed >= s.graduateMinReviewed && st.precision !== null
             && st.precision >= s.graduateMinPrecision;
  $("#grad").innerHTML = s.mode !== "shadow" ? ""
    : ready ? `<div class="grad">Ready to graduate — ${pct} over ${st.reviewed} reviewed messages.
               Switch the mode above whenever you want; the add-on will not do it for you.</div>`
            : `<div class="hint">Shadow mode. Graduation suggested at ${s.graduateMinReviewed} reviewed
               and ${(s.graduateMinPrecision*100).toFixed(0)}% precision — currently ${st.reviewed} and ${pct}.
               You can switch to Full at any time regardless.</div>`;

  const allow = await getAllow();
  const rows = Object.entries(allow).sort((a, b) => b[1].added - a[1].added);
  $("#allow").innerHTML = rows.length
    ? rows.map(([k, a]) => `<tr><td><code>${k}</code></td>
        <td>${a.sample ? `"${a.sample.slice(0,50)}"` : a.reason}</td>
        <td>${a.hits || 0} hits</td>
        <td><button data-revoke="${k}">Remove</button></td></tr>`).join("")
    : `<tr><td class="hint">Empty. It fills as you rescue messages.</td></tr>`;
  for (const b of document.querySelectorAll("[data-revoke]"))
    b.addEventListener("click", async () => { await revoke(b.dataset.revoke); load(); });
}

$("#save").addEventListener("click", async () => {
  const patch = {};
  for (const f of FIELDS) {
    const el = $("#" + f);
    patch[f] = el.type === "number" ? Number(el.value) : el.value;
  }
  for (const c of CHECKS) patch[c] = $("#" + c).checked;
  const boxes = [...document.querySelectorAll(".acct")];
  const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
  patch.watchedAccounts = chosen.length === boxes.length ? [] : chosen;
  await setSettings(patch);
  $("#saved").textContent = "saved";
  setTimeout(() => ($("#saved").textContent = ""), 1800);
  $("#suggest").addEventListener("click", async () => {
  const cur = $("#ownerNotes").value.trim();
  const sug = await suggestNotes();
  $("#ownerNotes").value = cur ? cur + "\n" + sug : sug;
  $("#ownerNotes").focus();
});
$("#mkfolders").addEventListener("click", async () => {
  $("#folders").innerHTML = '<span class="hint">creating…</span>';
  await browser.runtime.sendMessage({ cmd: "makeFolders" });
  load();
});

$("#reset").addEventListener("click", async () => {
  const keepReviewed = $("#keepReviewed").checked;
  const st = await stats();
  const ok = confirm(
    `Discard the model's verdicts and clear its tags?\n\n` +
    (keepReviewed
      ? `The ${st.reviewed} message(s) you reviewed yourself will be kept.\n`
      : `All verdicts will go, including the ${st.reviewed} you reviewed. ` +
        `Your precision history resets to zero.\n`) +
    `\nYour allow-list and learned corrections are NOT affected.\n\n` +
    `Nothing is deleted from your mail — only tags are removed.`);
  if (!ok) return;
  $("#rstat").textContent = "clearing…";
  const r = await browser.runtime.sendMessage({ cmd: "resetVerdicts", opts: { untag: true, keepReviewed } });
  $("#rstat").textContent =
    `cleared — ${r.untagged} message(s) untagged, kept ${r.allowKept} allow-listed sender(s) ` +
    `and ${r.correctionsKept} correction(s)`;
  load();
});

$("#export").addEventListener("click", async () => {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `localmailfilter-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  const n = Object.keys(data.allowlist).length;
  $("#bstatus").textContent = `exported ${n} allow-list entr${n === 1 ? "y" : "ies"}`;
});

$("#import").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await importAll(JSON.parse(await f.text()));
    $("#bstatus").textContent =
      `merged: ${r.allowlist} allow-listed, ${r.corrections} corrections, ${r.verdicts} verdicts`;
    load();
  } catch (err) {
    $("#bstatus").textContent = `import failed: ${err.message}`;
  }
});

load();
});

$("#test").addEventListener("click", async () => {
  $("#health").textContent = "checking…";
  const r = await browser.runtime.sendMessage({ cmd: "health" });
  if (!r.health) { $("#health").innerHTML = '<span class="bad">unreachable — is ollama.service running?</span>'; return; }
  const vram = r.loaded.length ? r.loaded.map((m) => m.name).join(", ") : "nothing loaded (GPU idle)";
  $("#health").innerHTML = r.health.hasModel
    ? `<span class="ok">connected</span> — ${vram}`
    : `<span class="bad">connected, but model not pulled</span>`;
});

$("#reportNow").addEventListener("click", async () => {
  $("#rstatus").textContent = "sending…";
  await browser.runtime.sendMessage({ cmd: "report" });
  $("#rstatus").textContent = "sent";
});
$("#openReport").addEventListener("click", () =>
  browser.tabs.create({ url: browser.runtime.getURL("ui/report.html") }));
$("#sweep").addEventListener("click", async () => {
  const r = await browser.runtime.sendMessage({ cmd: "sweepBacklog" });
  alert(`Moved ${r.moved} tagged message(s) to the Look At Later folder.`);
  load();
});
load();
