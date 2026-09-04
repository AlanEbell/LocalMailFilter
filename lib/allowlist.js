// The learning allow-list. A rescue (you moving a message back out of Look At Later,
// or marking it Wrong in the report) adds the sender's strongest identity key.
//
// Two deliberate limits:
//   1. Keys are DKIM domain > List-Id > exact address. Shared bulk infrastructure
//      (gmail.com, sendgrid, SES...) is never eligible as a domain key, so allow-listing
//      one Gmail correspondent does not allow-list all of Gmail.
//   2. An allow-list hit suppresses business_spam only. High-confidence phishing is
//      still flagged, because impersonating a sender you trust is the whole mechanism
//      of a phishing attack — the allow-list must not become a blind spot.

const PHISH_FLOOR = 0.85;

export async function getAllow() {
  const s = await browser.storage.local.get("allowlist");
  return s.allowlist || {};
}

export async function allow(keys, meta = {}) {
  if (!keys.length) return null;
  const list = await getAllow();
  const key = keys[0]; // strongest available
  list[key] = {
    added: Date.now(),
    hits: list[key]?.hits || 0,
    reason: meta.reason || "rescued",
    sample: meta.sample || "",
  };
  await browser.storage.local.set({ allowlist: list });
  return key;
}

export async function revoke(key) {
  const list = await getAllow();
  delete list[key];
  await browser.storage.local.set({ allowlist: list });
}

export async function matches(keys) {
  const list = await getAllow();
  for (const k of keys) {
    if (list[k]) {
      list[k].hits = (list[k].hits || 0) + 1;
      list[k].lastHit = Date.now();
      await browser.storage.local.set({ allowlist: list });
      return k;
    }
  }
  return null;
}

// Should an allow-list match suppress this verdict?
export function suppresses(verdict) {
  if (verdict.category === "legitimate") return true;
  if (verdict.category === "phishing" && verdict.confidence >= PHISH_FLOOR) return false;
  return true;
}

// ---- few-shot memory ---------------------------------------------------
// The allow-list can only stop repeat offenders. Corrections teach the model the
// *pattern*, so similar mail from new senders stops being flagged too.

const MAX_SHOTS = 6;

export async function getCorrections() {
  const s = await browser.storage.local.get("corrections");
  return s.corrections || [];
}

export async function addCorrection(c) {
  const list = await getCorrections();
  list.unshift({ ...c, ts: Date.now() });
  await browser.storage.local.set({ corrections: list.slice(0, 40) });
}

export async function fewShotBlock() {
  const list = await getCorrections();
  if (!list.length) return "";
  const fp = list.filter((c) => c.kind === "false_positive").slice(0, MAX_SHOTS);
  const fn = list.filter((c) => c.kind === "false_negative").slice(0, MAX_SHOTS);
  let out = "\n\nCORRECTIONS FROM THE MAILBOX OWNER — learn the pattern, not just the sender:\n";
  for (const c of fp) {
    out += `- LEGITIMATE, but you wrongly called it ${c.was}: "${c.subject}" from ${c.from}\n`;
  }
  for (const c of fn) {
    out += `- ${c.should.toUpperCase()}, but you wrongly called it legitimate: "${c.subject}" from ${c.from}\n`;
  }
  return fp.length || fn.length ? out : "";
}
