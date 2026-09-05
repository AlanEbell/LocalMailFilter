import { getSettings, setSettings, stats, exportAll, importAll, localDay } from "../lib/store.js";
import { getAllow, revoke } from "../lib/allowlist.js";
import { buildOwnerBlock, suggestNotes } from "../lib/owner.js";

const $ = (s) => document.querySelector(s);
const FIELDS = ["mode","endpoint","model","bodyChars","folderName","reportEmail","reportHour","ownerNotes"];
const CHECKS = ["emailReport","notifyOnSort"];

// ---- error reporting ---------------------------------------------------
// Failures on an extension options page go to a console that is awkward to reach.
// Two silent no-op bugs in this UI were expensive to find for exactly that reason,
// so errors are shown on the page and persisted where they can be recovered.

const errors = [];
function reportError(where, err) {
  const line = `${new Date().toLocaleTimeString()}  ${where}: ${err?.message || err}` +
               (err?.stack ? `\n${String(err.stack).split("\n").slice(0, 4).join("\n")}` : "");
  errors.push(line);
  const box = $("#errbox");
  if (box) {
    box.hidden = false;
    box.innerHTML = "<h3>Something went wrong — please send this to Claude</h3>";
    box.appendChild(document.createTextNode(errors.join("\n\n")));
  }
  try { browser.storage.local.set({ uiErrors: errors.slice(-20) }); } catch { /* nothing else to do */ }
}
window.addEventListener("error", (e) => reportError("uncaught", e.error || e));
window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));

// Registering through a helper means a missing element is reported rather than
// throwing at module top level and silently taking every later handler with it.
function on(sel, fn) {
  const el = $(sel);
  if (!el) { reportError("wiring", new Error(`element ${sel} not found`)); return; }
  el.addEventListener("click", async (ev) => {
    try { await fn(ev); } catch (err) { reportError(sel, err); }
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- rendering ---------------------------------------------------------

async function load() {
  const s = await getSettings();
  for (const f of FIELDS) $("#" + f).value = s[f];
  for (const c of CHECKS) $("#" + c).checked = !!s[c];

  const mf = browser.runtime.getManifest();
  $("#ver").textContent = "v" + mf.version;
  $("#foot").innerHTML =
    `<span>Mail Triage <strong>v${mf.version}</strong></span>` +
    `<span>Thunderbird ${navigator.userAgent.match(/Thunderbird\/([\d.]+)/)?.[1] || "?"}</span>` +
    `<span>model <strong>${escapeHtml(s.model)}</strong> at ${escapeHtml(s.endpoint)}</span>` +
    `<span><a href="https://github.com/AlanEbell/LocalMailFilter" target="_blank">source</a></span>`;

  // Nothing here should ask for something Thunderbird already knows.
  const accts = (await browser.accounts.list(false)).filter((a) => a.type === "imap" || a.type === "pop3");
  if (!s.reportEmail) {
    const first = accts.flatMap((a) => a.identities || []).find((i) => i.email);
    if (first) $("#reportEmail").value = first.email;
  }
  $("#derived").textContent = await buildOwnerBlock("");

  $("#accounts").innerHTML = accts.map((a) => {
    const on_ = !s.watchedAccounts.length || s.watchedAccounts.includes(a.id);
    return `<div><label><input type="checkbox" class="acct" value="${escapeHtml(a.id)}" ${
      on_ ? "checked" : ""}> ${escapeHtml(a.name)}</label></div>`;
  }).join("") + `<div class="hint">Unchecking all is treated as "watch all".</div>`;

  browser.runtime.sendMessage({ cmd: "folders" }).then((fs) => {
    $("#folders").innerHTML = (fs || []).map((f) =>
      f.ok ? `<div><span class="ok">✓</span> ${escapeHtml(f.account)} <code>${escapeHtml(f.path || "")}</code></div>`
           : `<div><span class="bad">✗</span> ${escapeHtml(f.account)} — no folder; tag-only</div>`
    ).join("") || '<span class="hint">no accounts watched</span>';
  }).catch((e) => reportError("folders", e));

  browser.runtime.sendMessage({ cmd: "resetInfo" }).then((info) => {
    if (!info) return;
    $("#undo").hidden = false;
    $("#undo").title = `Restores ${info.count} verdict(s) cleared on ${new Date(info.at).toLocaleString()}`;
  }).catch(() => {});

  const st = await stats();
  const pct = st.precision === null ? "—" : (st.precision * 100).toFixed(1) + "%";
  $("#stats").innerHTML =
    `<div><b>${st.flagged}</b><span>flagged all-time</span></div>` +
    `<div><b>${st.reviewed}</b><span>you reviewed</span></div>` +
    `<div><b>${st.wrong}</b><span>false positives</span></div>` +
    `<div><b>${pct}</b><span>precision</span></div>`;

  const ready = st.reviewed >= s.graduateMinReviewed && st.precision !== null
             && st.precision >= s.graduateMinPrecision;
  $("#grad").innerHTML = s.mode !== "shadow" ? ""
    : ready ? `<div class="grad">Ready to graduate — ${pct} over ${st.reviewed} reviewed messages.
               Switch the mode above whenever you want; the add-on will not do it for you.</div>`
            : `<div class="hint">Shadow mode. Graduation is suggested at ${s.graduateMinReviewed} reviewed
               and ${(s.graduateMinPrecision * 100).toFixed(0)}% precision — currently ${st.reviewed} and ${pct}.
               You can switch to Full at any time regardless.</div>`;

  const allow = await getAllow();
  const rows = Object.entries(allow).sort((a, b) => b[1].added - a[1].added);
  $("#allow").innerHTML = rows.length
    ? rows.map(([k, a]) => `<tr><td><code>${escapeHtml(k)}</code></td>
        <td>${a.sample ? `"${escapeHtml(a.sample.slice(0, 50))}"` : escapeHtml(a.reason || "")}</td>
        <td>${a.hits || 0} hits</td>
        <td><button data-revoke="${escapeHtml(k)}">Remove</button></td></tr>`).join("")
    : `<tr><td class="hint">Empty. It fills as you rescue messages.</td></tr>`;
  for (const b of document.querySelectorAll("[data-revoke]")) {
    b.addEventListener("click", async () => {
      try { await revoke(b.dataset.revoke); load(); } catch (e) { reportError("revoke", e); }
    });
  }
}

// ---- handlers (all top level, so all are registered on load) -----------

on("#save", async () => {
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
  load();
});

on("#suggest", async () => {
  const cur = $("#ownerNotes").value.trim();
  const sug = await suggestNotes();
  $("#ownerNotes").value = cur ? cur + "\n" + sug : sug;
  $("#ownerNotes").focus();
});

on("#mkfolders", async () => {
  $("#folders").innerHTML = '<span class="hint">creating…</span>';
  await browser.runtime.sendMessage({ cmd: "makeFolders" });
  load();
});

on("#test", async () => {
  $("#health").textContent = "checking…";
  const r = await browser.runtime.sendMessage({ cmd: "health" });
  if (!r.health) { $("#health").innerHTML = '<span class="bad">unreachable — is ollama.service running?</span>'; return; }
  const vram = r.loaded.length ? r.loaded.map((m) => m.name).join(", ") : "nothing loaded (GPU idle)";
  $("#health").innerHTML = r.health.hasModel
    ? `<span class="ok">connected</span> — ${escapeHtml(vram)}`
    : `<span class="bad">connected, but model not pulled</span>`;
});

on("#reportNow", async () => {
  $("#rstatus").textContent = "sending…";
  await browser.runtime.sendMessage({ cmd: "report" });
  $("#rstatus").textContent = "sent";
});

on("#openReport", () => browser.tabs.create({ url: browser.runtime.getURL("ui/report.html") }));

on("#sweep", async () => {
  const r = await browser.runtime.sendMessage({ cmd: "sweepBacklog" });
  alert(`Moved ${r.moved} tagged message(s) to the Look At Later folder.`);
  load();
});

on("#repair", async () => {
  $("#repstat").textContent = "repairing…";
  const r = await browser.runtime.sendMessage({ cmd: "repairAgreeBug" });
  $("#repstat").textContent =
    `removed ${r.droppedCorrections} bogus correction(s) and ${r.droppedVerdicts} affected verdict(s), ` +
    `untagged ${r.untagged}; allow-list intact (${r.allowKept} entries)`;
  load();
});

on("#reset", async () => {
  const keepReviewed = $("#keepReviewed").checked;
  const st = await stats();
  const ok = confirm(
    `Discard the model's verdicts and clear its tags?\n\n` +
    (keepReviewed
      ? `The ${st.reviewed} message(s) you reviewed yourself will be kept.\n`
      : `All verdicts will go, including the ${st.reviewed} you reviewed. Your precision history resets to zero.\n`) +
    `\nYour allow-list and learned corrections are NOT affected.\n\n` +
    `Nothing is deleted from your mail — only tags are removed.`);
  if (!ok) return;
  $("#rstat").textContent = "clearing…";
  const r = await browser.runtime.sendMessage({ cmd: "resetVerdicts", opts: { untag: true, keepReviewed } });
  $("#rstat").textContent =
    `cleared — ${r.untagged} message(s) untagged, kept ${r.allowKept} allow-listed sender(s) and ${r.correctionsKept} correction(s)`;
  load();
});

on("#undo", async () => {
  const r = await browser.runtime.sendMessage({ cmd: "undoReset" });
  $("#rstat").textContent = r.restored
    ? `restored ${r.restored} verdict(s) — tags were not restored`
    : "nothing to restore";
  load();
});

// ---- backup ------------------------------------------------------------

on("#export", async () => {
  $("#bstatus").textContent = "preparing…";
  const text = JSON.stringify(await exportAll(), null, 2);
  const name = `localmailfilter-backup-${localDay()}.json`;

  // Render it on the page first. A backup you cannot retrieve is worse than no
  // backup button, so the path that cannot fail runs before the one that can.
  showBackup(text, name);
  $("#bstatus").textContent = "backup ready below";

  try {
    if (browser.downloads?.download) {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      await browser.downloads.download({ url, filename: name, saveAs: true });
      $("#bstatus").textContent = `saved ${name} (also shown below)`;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) {
    $("#bstatus").textContent = `backup ready below (file save unavailable: ${e.message})`;
  }
});

function showBackup(text, name) {
  let box = $("#fallback");
  if (!box) {
    box = document.createElement("div");
    box.id = "fallback";
    box.style.marginTop = "10px";
    $("#bstatus").parentNode.appendChild(box);
  }
  box.innerHTML =
    `<div class="hint" style="margin-bottom:6px">Backup (${text.length} bytes). Save as <code>${escapeHtml(name)}</code>:</div>` +
    `<textarea id="bkarea" readonly style="width:100%;height:130px;font:12px ui-monospace,monospace;` +
    `border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);padding:8px"></textarea>` +
    `<div style="margin-top:6px"><button id="copyb">Copy to clipboard</button> ` +
    `<button id="saveb">Save as file</button> <span id="cstat" class="hint"></span></div>`;
  const area = box.querySelector("#bkarea");
  area.value = text;

  box.querySelector("#copyb").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); }
    catch { area.select(); document.execCommand?.("copy"); }
    box.querySelector("#cstat").textContent = "copied";
  });

  box.querySelector("#saveb").addEventListener("click", async () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    try {
      if (browser.downloads?.download) {
        await browser.downloads.download({ url, filename: name, saveAs: true });
        box.querySelector("#cstat").textContent = "saved";
      } else {
        await browser.tabs.create({ url });
        box.querySelector("#cstat").textContent = "opened in a tab — press Ctrl+S to save";
      }
    } catch (e) {
      box.querySelector("#cstat").textContent = `save failed: ${e.message}`;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

on("#import", () => $("#importFile").click());

$("#importFile")?.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await importAll(JSON.parse(await f.text()));
    $("#bstatus").textContent =
      `merged: ${r.allowlist} allow-listed, ${r.corrections} corrections, ${r.verdicts} verdicts`;
    load();
  } catch (err) {
    reportError("import", err);
  }
});

load().catch((e) => reportError("load", e));
