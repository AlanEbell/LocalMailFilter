// Persistent state. Everything lives in browser.storage.local — no network, no disk writes
// outside Thunderbird's own profile.

const DEFAULTS = {
  // "shadow" = tag only, never move. "confident" = move clear-cut calls only. "full" = move all flags.
  mode: "shadow",
  model: "qwen3:8b",
  endpoint: "http://localhost:11434",
  // Accounts to watch, by accountId. Empty = all accounts with an INBOX.
  watchedAccounts: [],
  folderName: "Look At Later",
  bodyChars: 1500,
  // Who the mailbox belongs to. Injected into the classifier prompt at runtime and
  // stored only in local Thunderbird storage — never committed to the repository.
  ownerContext: `The mailbox owner is <YOUR NAME>. Their addresses: <you@example.com>.
Known affiliations — mail from or about these is legitimate correspondence, never spam:
  - <Organisation> / <domain.org> — <what it is and your relationship to it>
  - <Your business> / <yourbusiness.com> — <sales@... is a PUBLIC SALES ADDRESS if applicable>`,
  // Report delivery
  reportEmail: "",   // set in the options page; blank disables the emailed report
  reportHour: 7,
  notifyOnSort: true,
  emailReport: true,
  // Graduation thresholds — the add-on only ever *suggests*; it never flips mode itself.
  graduateMinReviewed: 50,
  graduateMinPrecision: 0.95,
  graduationOffered: false,
  lastReportDate: null,
};

export async function getSettings() {
  const s = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(s.settings || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

// ---- verdict log -------------------------------------------------------
// One record per classified message. Keyed by headerMessageId because numeric
// message ids change when a message moves between folders.

export async function getVerdicts() {
  const s = await browser.storage.local.get("verdicts");
  return s.verdicts || {};
}

export async function putVerdict(rec) {
  const v = await getVerdicts();
  v[rec.headerMessageId] = { ...(v[rec.headerMessageId] || {}), ...rec };
  await browser.storage.local.set({ verdicts: v });
}

export async function updateVerdict(headerMessageId, patch) {
  const v = await getVerdicts();
  if (!v[headerMessageId]) return null;
  v[headerMessageId] = { ...v[headerMessageId], ...patch };
  await browser.storage.local.set({ verdicts: v });
  return v[headerMessageId];
}

// Drop records older than `days` so storage does not grow without bound.
export async function pruneVerdicts(days = 90) {
  const cutoff = Date.now() - days * 86400000;
  const v = await getVerdicts();
  let dropped = 0;
  for (const [k, rec] of Object.entries(v)) {
    if ((rec.ts || 0) < cutoff) { delete v[k]; dropped++; }
  }
  if (dropped) await browser.storage.local.set({ verdicts: v });
  return dropped;
}

// ---- work queue --------------------------------------------------------
// Messages waiting to be classified. Survives Thunderbird restarts and Ollama
// being unreachable — nothing is lost if the model is unavailable.

export async function getQueue() {
  const s = await browser.storage.local.get("queue");
  return s.queue || [];
}

export async function enqueue(items) {
  const q = await getQueue();
  const seen = new Set(q.map((i) => i.headerMessageId));
  const add = items.filter((i) => !seen.has(i.headerMessageId));
  if (add.length) await browser.storage.local.set({ queue: q.concat(add) });
  return add.length;
}

export async function dequeue(headerMessageIds) {
  const drop = new Set(headerMessageIds);
  const q = (await getQueue()).filter((i) => !drop.has(i.headerMessageId));
  await browser.storage.local.set({ queue: q });
}

// ---- accuracy stats ----------------------------------------------------

export async function stats() {
  const v = Object.values(await getVerdicts());
  const reviewed = v.filter((r) => r.userVerdict);
  const correct = reviewed.filter((r) => r.userVerdict === "agree").length;
  const wrong = reviewed.filter((r) => r.userVerdict === "wrong").length;
  const byCat = {};
  for (const c of ["business_spam", "phishing"]) {
    const sub = reviewed.filter((r) => r.category === c);
    byCat[c] = {
      reviewed: sub.length,
      correct: sub.filter((r) => r.userVerdict === "agree").length,
    };
  }
  return {
    flagged: v.filter((r) => r.category !== "legitimate").length,
    reviewed: reviewed.length,
    correct,
    wrong,
    precision: reviewed.length ? correct / reviewed.length : null,
    byCat,
  };
}
