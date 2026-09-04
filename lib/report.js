// Daily report: an HTML summary of what was flagged, what was learned, and how
// accurate the model has been. Rendered into a Thunderbird tab and optionally
// mailed to you so you can read it on your phone.

import { getVerdicts, getSettings, stats } from "./store.js";
import { getAllow, getCorrections } from "./allowlist.js";

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function reportData(day) {
  const all = await getVerdicts();
  const start = new Date(day + "T00:00:00").getTime();
  const end = start + 86400000;
  const today = Object.entries(all)
    .map(([hmid, r]) => ({ ...r, headerMessageId: hmid }))
    .filter((r) => r.ts >= start && r.ts < end);

  const flagged = today.filter((r) => r.category !== "legitimate");
  const allow = await getAllow();
  const newlyAllowed = Object.entries(allow).filter(([, a]) => a.added >= start && a.added < end);
  const rescues = Object.entries(all).filter(([, r]) => r.rescuedAt >= start && r.rescuedAt < end);

  return {
    day, flagged,
    spam: flagged.filter((r) => r.category === "business_spam"),
    phish: flagged.filter((r) => r.category === "phishing"),
    scanned: today.length,
    allowlisted: today.filter((r) => r.action === "skipped-allowlist").length,
    newlyAllowed, rescues,
    st: await stats(),
    settings: await getSettings(),
  };
}

function row(r) {
  const badge = r.category === "phishing"
    ? '<span class="b phish">phishing</span>'
    : '<span class="b spam">business spam</span>';
  const act = { moved: "moved", tagged: "tagged only", "tagged-unsure": "tagged (unsure)",
                "tagged-nofolder": "tagged (no folder!)" }[r.action] || r.action;
  return `<tr>
    <td>${badge}</td>
    <td class="sub"><strong>${esc(r.subject)}</strong><br><span class="from">${esc(r.from)}</span></td>
    <td class="reason">${esc(r.reason)}</td>
    <td class="act">${esc(act)}</td>
    <td class="btns" data-hmid="${esc(r.headerMessageId)}">
      <button class="ok" data-act="confirm">Agree</button>
      <button class="no" data-act="wrong">Wrong</button>
    </td></tr>`;
}

export async function renderReport(day, { interactive = false } = {}) {
  const d = await reportData(day);
  const pct = d.st.precision === null ? "—" : (d.st.precision * 100).toFixed(1) + "%";
  const modeNote = {
    shadow: "Shadow mode — nothing was moved. These are tags only.",
    confident: "Confident mode — only clear-cut calls were moved.",
    full: "Full mode — everything flagged was moved.",
  }[d.settings.mode];

  const rows = d.flagged.length
    ? d.flagged.map(row).join("")
    : `<tr><td colspan="5" class="empty">Nothing flagged today.</td></tr>`;

  return `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --mut:#666; --line:#e3e3e3; --card:#f7f7f8; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --bg:#1c1c1e; --mut:#9a9a9a; --line:#333; --card:#252528; } }
  body { font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .day { color: var(--mut); margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; min-width: 110px; }
  .card .n { font-size: 24px; font-weight: 600; } .card .l { color: var(--mut); font-size: 12px; }
  .note { background: var(--card); border-left: 3px solid #E5A50A; padding: 10px 14px; border-radius: 4px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; color: var(--mut); text-transform: uppercase; letter-spacing: .04em; }
  .b { font-size: 11px; padding: 2px 7px; border-radius: 10px; white-space: nowrap; font-weight: 600; }
  .spam { background: #E5A50A22; color: #9a6f00; } .phish { background: #E01B2422; color: #c01019; }
  @media (prefers-color-scheme: dark) { .spam { color:#f0c04a; } .phish { color:#ff7b7b; } }
  .from, .reason, .act { color: var(--mut); font-size: 13px; } .sub { max-width: 300px; } .reason { max-width: 380px; }
  .empty { color: var(--mut); text-align: center; padding: 30px; }
  .btns button { font: inherit; font-size: 12px; padding: 3px 10px; margin-right: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
  .btns button:hover { background: var(--card); } .btns .done { color: var(--mut); font-size: 12px; }
  h2 { font-size: 14px; margin: 24px 0 8px; } ul { margin: 0; padding-left: 20px; color: var(--mut); }
  code { background: var(--card); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
<h1>Mail Triage</h1><div class="day">${esc(d.day)}</div>
<div class="cards">
  <div class="card"><div class="n">${d.scanned}</div><div class="l">scanned</div></div>
  <div class="card"><div class="n">${d.spam.length}</div><div class="l">business spam</div></div>
  <div class="card"><div class="n">${d.phish.length}</div><div class="l">possible phishing</div></div>
  <div class="card"><div class="n">${d.allowlisted}</div><div class="l">skipped (trusted)</div></div>
  <div class="card"><div class="n">${pct}</div><div class="l">precision (${d.st.reviewed} reviewed)</div></div>
</div>
<div class="note">${esc(modeNote)}</div>
<table><tr><th>Verdict</th><th>Message</th><th>Why</th><th>Action</th><th>${interactive ? "Correct?" : ""}</th></tr>${rows}</table>
${d.newlyAllowed.length ? `<h2>Senders added to your allow-list today</h2><ul>${
  d.newlyAllowed.map(([k, a]) => `<li><code>${esc(k)}</code> — ${esc(a.reason)}${a.sample ? `: "${esc(a.sample)}"` : ""}</li>`).join("")}</ul>` : ""}
${d.rescues.length ? `<h2>Corrections learned today</h2><ul>${
  d.rescues.map(([, r]) => `<li>"${esc(r.subject)}" from ${esc(r.from)} — was ${esc(r.category)}${r.rescuedVia ? ` (${esc(r.rescuedVia)})` : ""}</li>`).join("")}</ul>` : ""}
`;
}

export async function sendReportEmail(s, day, html) {
  const accts = await browser.accounts.list(false);
  let identityId = null;
  for (const a of accts) {
    const id = (a.identities || []).find((i) => i.email === s.reportEmail) || (a.identities || [])[0];
    if (id) { identityId = id.id; if (id.email === s.reportEmail) break; }
  }
  // The emailed copy is deliberately read-only; mail clients cannot run the
  // Agree/Wrong buttons, so those live in the Thunderbird tab.
  const body = html.replace(/<td class="btns"[\s\S]*?<\/td>/g, "<td></td>")
                   .replace(/<th>Correct\?<\/th>/, "<th></th>");
  const tab = await browser.compose.beginNew({
    to: [s.reportEmail],
    subject: `Mail Triage — ${day}`,
    body,
    identityId: identityId || undefined,
  });
  await browser.compose.sendMessage(tab.id, { mode: "sendNow" });
}
