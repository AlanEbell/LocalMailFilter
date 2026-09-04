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
  // Only the part Thunderbird cannot know: what each of your domains actually IS.
  // Addresses, display name and accounts are read from the account config at runtime.
  ownerNotes: "",
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

// ---- backup / restore --------------------------------------------------
// Thunderbird allocates a fresh storage area when an add-on is uninstalled and
// reinstalled, silently discarding everything below. Upgrading in place (a higher
// version number) preserves it, but an uninstall never will — so the learned data
// must be exportable.

export async function exportAll() {
  const all = await browser.storage.local.get(null);
  return {
    format: "localmailfilter/1",
    exported: new Date().toISOString(),
    settings: all.settings || {},
    allowlist: all.allowlist || {},
    corrections: all.corrections || [],
    verdicts: all.verdicts || {},
  };
}

// Merge rather than replace: an import should never destroy senders you have
// trusted since the backup was taken.
export async function importAll(data, { merge = true } = {}) {
  if (!data || data.format !== "localmailfilter/1") throw new Error("Not a LocalMailFilter backup file.");
  const cur = await browser.storage.local.get(null);
  const out = {};

  out.allowlist = merge ? { ...(data.allowlist || {}), ...(cur.allowlist || {}) } : (data.allowlist || {});
  out.verdicts  = merge ? { ...(data.verdicts  || {}), ...(cur.verdicts  || {}) } : (data.verdicts  || {});

  if (merge) {
    const seen = new Set();
    out.corrections = [...(cur.corrections || []), ...(data.corrections || [])]
      .filter((c) => {
        const k = `${c.kind}|${c.from}|${c.subject}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 40);
  } else {
    out.corrections = data.corrections || [];
  }

  // Settings are only filled in where the current profile has nothing set.
  out.settings = { ...(data.settings || {}), ...(cur.settings || {}) };

  await browser.storage.local.set(out);
  return {
    allowlist: Object.keys(out.allowlist).length,
    verdicts: Object.keys(out.verdicts).length,
    corrections: out.corrections.length,
  };
}
