import { getSettings, setSettings, putVerdict, updateVerdict, getVerdicts,
         enqueue, dequeue, getQueue, stats, pruneVerdicts, localDay } from "./lib/store.js";
import { Ollama } from "./lib/ollama.js";
import { buildPrompt, identityKeys, emailAddress } from "./lib/extract.js";
import { withOwner } from "./lib/prompt.js";
import { buildOwnerBlock } from "./lib/owner.js";
import * as AL from "./lib/allowlist.js";
import { renderReport, sendReportEmail } from "./lib/report.js";

const TAGS = {
  business_spam: { key: "triagespam",  name: "Triage: Business Spam",   color: "#E5A50A" },
  phishing:      { key: "triagephish", name: "Triage: Possible Phishing", color: "#E01B24" },
};

const log = (...a) => console.log("[triage]", ...a);

let draining = false;
let rerunRequested = false;
let stopRequested = false;

// Progress broadcasts to any open report tab. Rejects harmlessly when nothing
// is listening, which is the normal case.
function emit(payload) {
  browser.runtime.sendMessage(payload).catch(() => {});
}

// ---- folder plumbing ---------------------------------------------------

async function watchedAccounts() {
  const s = await getSettings();
  const accts = await browser.accounts.list(false);
  const usable = accts.filter((a) => a.type === "imap" || a.type === "pop3");
  if (!s.watchedAccounts.length) return usable;
  return usable.filter((a) => s.watchedAccounts.includes(a.id));
}

async function inboxOf(account) {
  const folders = await browser.folders.query({ accountId: account.id, specialUse: ["inbox"] });
  return folders[0] || null;
}

async function rootOf(account) {
  try {
    const full = await browser.accounts.get(account.id, false);
    return full?.rootFolder || null;
  } catch { return null; }
}

// Find (or create) the Look At Later folder. The account root is preferred.
//
// A child of INBOX seems more natural, but Thunderbird auto-enrols new subfolders of
// INBOX into the unified Inbox's search scope, so sorted mail kept matching the
// unified Inbox and never left the feed. iCloud, which refuses subfolders of INBOX
// and forces everything to the account root, was the account that behaved correctly.
//
// Not every provider allows a folder at the root, so creation falls back to INBOX
// rather than leaving the account permanently without a destination. Lookup still
// checks both places, so a folder already living under INBOX is found and reused.
async function triageFolderOf(account, create = true) {
  const s = await getSettings();
  const inbox = await inboxOf(account);

  // An existing folder may be in either place, including one you moved yourself.
  for (const parent of [inbox, await rootOf(account)]) {
    if (!parent) continue;
    try {
      const subs = await browser.folders.getSubFolders(parent.id, false);
      const found = subs.find((f) => f.name === s.folderName);
      if (found) return found;
    } catch { /* keep looking */ }
  }
  if (!create) return null;

  const root = await rootOf(account);
  if (root) {
    try {
      const f = await browser.folders.create(root.id, s.folderName);
      log("created", s.folderName, "at account root in", account.name);
      return f;
    } catch (e) {
      log(`${account.name}: server refused a folder at the account root (${e.message}); trying INBOX`);
    }
  }

  if (inbox) {
    try {
      const f = await browser.folders.create(inbox.id, s.folderName);
      log("created", s.folderName, "under INBOX in", account.name);
      return f;
    } catch (e) {
      log(`${account.name}: could not create ${s.folderName} anywhere — ${e.message}`);
    }
  }
  return null;
}

// Which accounts currently lack a destination folder. Surfaced in the settings page
// so a failure is visible rather than buried in a log nobody reads.
async function foldersStatus() {
  const out = [];
  for (const a of await watchedAccounts()) {
    const f = await triageFolderOf(a, false);
    out.push({ account: a.name, ok: !!f, path: f?.path || null });
  }
  return out;
}

async function ensureTags() {
  const existing = await browser.messages.tags.list();
  for (const t of Object.values(TAGS)) {
    if (!existing.find((e) => e.key === t.key)) {
      await browser.messages.tags.create(t.key, t.name, t.color);
      log("created tag", t.name);
    }
  }
}

// ---- classification ----------------------------------------------------

async function drainQueue({ manual = false } = {}) {
  // Mail that arrives mid-batch used to wait for the next 10-minute alarm: the
  // listener enqueued it, called drainQueue, and was turned away because a batch
  // was already running. At ~2.5s a message a backfill can run for minutes, so
  // "it didn't scan my new mail right away" was this. Remember the request and
  // run again once the current batch finishes.
  if (draining) { rerunRequested = true; return { processed: 0, skipped: "already-running" }; }
  stopRequested = false;
  const s = await getSettings();
  const queue = await getQueue();
  if (!queue.length) return { processed: 0, skipped: "empty" };
  draining = true;

  const oll = new Ollama(s.endpoint, s.model);
  const health = await oll.health();
  if (!health) {
    log("ollama unreachable — leaving", queue.length, "queued");
    if (manual) notify("Ollama unreachable", `${queue.length} message(s) still queued. Start the service and try again.`);
    draining = false;
    emit({ evt: "done", skipped: "ollama-down" });
    return { processed: 0, skipped: "ollama-down" };
  }
  if (!health.hasModel) {
    notify("Model missing", `${s.model} is not pulled. Run: ollama pull ${s.model}`);
    draining = false;
    emit({ evt: "done", skipped: "model-missing" });
    return { processed: 0, skipped: "model-missing" };
  }

  const vramBefore = await oll.loaded();
  const shots = await AL.fewShotBlock();
  const sys = withOwner(await buildOwnerBlock(s.ownerNotes)) + shots;
  const done = [];
  const counts = { business_spam: 0, phishing: 0, legitimate: 0, allowlisted: 0 };
  emit({ evt: "start", total: queue.length });

  try {
    for (const item of queue) {
      if (stopRequested) { log("stop requested, ending batch early"); break; }
      try {
        const hdr = await browser.messages.get(item.id).catch(() => null);
        if (!hdr) { done.push(item.headerMessageId); continue; }
        const full = await browser.messages.getFull(item.id);
        const keys = identityKeys(hdr, full);

        // Allow-list short-circuit: known-good senders never reach the model at all.
        const hit = await AL.matches(keys);
        if (hit) {
          const probe = { category: "legitimate", confidence: 1 };
          if (AL.suppresses(probe)) {
            counts.allowlisted++;
            await putVerdict({
              headerMessageId: item.headerMessageId, ts: Date.now(),
              account: item.account, from: emailAddress(hdr.author), subject: hdr.subject,
              category: "legitimate", confidence: 1, reason: `allow-listed (${hit})`,
              evidence: [], action: "skipped-allowlist",
            });
            emit({ evt: "item", done: done.length + 1, total: queue.length, counts,
                   subject: hdr.subject, from: emailAddress(hdr.author),
                   category: "legitimate", note: "trusted sender, model skipped" });
            done.push(item.headerMessageId);
            await dequeue([item.headerMessageId]);
            continue;
          }
        }

        const text = buildPrompt(hdr, full, s.bodyChars);
        const v = await oll.classify(sys, text);
        counts[v.category] = (counts[v.category] || 0) + 1;

        // An allow-listed sender still gets flagged for confident phishing.
        if (hit && AL.suppresses(v)) {
          v.category = "legitimate";
          v.reason = `allow-listed (${hit}); model said otherwise but sender is trusted`;
        }

        const action = await applyVerdict(item, hdr, v, s);
        await putVerdict({
          headerMessageId: item.headerMessageId, ts: Date.now(),
          account: item.account, from: emailAddress(hdr.author), subject: hdr.subject,
          category: v.category, confidence: v.confidence, reason: v.reason,
          evidence: v.evidence, keys, action,
        });
        emit({ evt: "item", done: done.length + 1, total: queue.length, counts,
               subject: hdr.subject, from: emailAddress(hdr.author),
               category: v.category, reason: v.reason, action });
        done.push(item.headerMessageId);
        // Drop it from the queue immediately: a restart mid-batch should resume,
        // not reclassify everything already paid for.
        await dequeue([item.headerMessageId]);
      } catch (e) {
        log("classify failed", item.headerMessageId, e.message);
        counts.failed = (counts.failed || 0) + 1;
        emit({ evt: "item", done: done.length + 1, total: queue.length, counts,
               subject: "(could not classify)", from: "", category: "error", reason: e.message });
        // Record the failure so the message is visible in the report rather than
        // silently skipped, and drop it from the queue right away: retrying a
        // message that just poisoned the model only stalls the batch again.
        await putVerdict({
          headerMessageId: item.headerMessageId, ts: Date.now(), account: item.account,
          from: "", subject: "(could not classify)", category: "legitimate",
          confidence: 0, reason: `classifier error: ${e.message}`, evidence: [],
          action: "left", failed: true,
        });
        done.push(item.headerMessageId);
        await dequeue([item.headerMessageId]);
      }
    }
  } finally {
    // Always release the GPU, even if the loop threw.
    await oll.unload();
    draining = false;
  }

  await dequeue(done);
  const vramAfter = await oll.loaded();
  log("batch done", counts, "vram released:", vramAfter.length === 0);

  // Anything queued while this batch was busy gets picked up now rather than at
  // the next alarm. The queue shrinks every pass — items are dequeued even when
  // they fail — so this terminates.
  if (rerunRequested) {
    rerunRequested = false;
    if ((await getQueue()).length) setTimeout(() => void drainQueue(), 0);
  }

  const flagged = counts.business_spam + counts.phishing;
  if (flagged && s.notifyOnSort) {
    const verb = s.mode === "shadow" ? "Tagged" : "Sorted";
    notify(`${verb} ${flagged} message${flagged === 1 ? "" : "s"}`,
      `${counts.business_spam} business spam, ${counts.phishing} possible phishing` +
      (s.mode === "shadow" ? " — shadow mode, nothing moved." : ""));
  }
  await maybeOfferGraduation();
  emit({ evt: "done", processed: done.length, counts, gpuReleased: vramAfter.length === 0 });
  return { processed: done.length, counts, vramBefore, vramAfter };
}

// Decide what physically happens to a message. Nothing here can delete: the add-on
// does not hold the messagesDelete permission.
async function applyVerdict(item, hdr, v, s) {
  if (v.category === "legitimate") return "left";

  // Tag in every mode — the tag is the audit trail even after a move.
  const tag = TAGS[v.category];
  const tags = [...new Set([...(hdr.tags || []), tag.key])];
  await browser.messages.update(item.id, { tags }).catch((e) => log("tag failed", e.message));

  if (s.mode === "shadow") return "tagged";
  if (s.mode === "confident" && !isClearCut(v)) return "tagged-unsure";

  const acct = (await browser.accounts.list(false)).find((a) => a.id === item.account);
  const dest = acct ? await triageFolderOf(acct) : null;
  if (!dest) {
    log(`no destination folder for account ${item.account}; message tagged only`);
    return "tagged-nofolder";
  }
  await browser.messages.move([item.id], dest.id);
  return "moved";
}

// The model's self-reported confidence clusters near 0.95 regardless of difficulty,
// so "confident mode" gates on corroborating evidence instead of trusting the number.
function isClearCut(v) {
  const cited = (v.evidence || []).filter((e) => e && e.length > 15).length;
  if (v.category === "phishing") return cited >= 2 && v.confidence >= 0.8;
  return cited >= 2 && v.confidence >= 0.85;
}

// ---- events ------------------------------------------------------------

browser.messages.onNewMailReceived.addListener(async (folder, messages) => {
  const accts = await watchedAccounts();
  if (!accts.find((a) => a.id === folder.accountId)) return;
  if (folder.specialUse && !folder.specialUse.includes("inbox")) return;
  const items = messages.messages.map((m) => ({
    id: m.id, headerMessageId: m.headerMessageId, account: folder.accountId,
  }));
  const n = await enqueue(items);
  if (n) { log("queued", n, "from", folder.accountId); drainQueue(); }
});

// Scan on demand from the message list. Two reasons this exists: new mail is
// occasionally not picked up promptly, and — the more useful case — you want a
// straight answer about a message you already suspect is phishing.
//
// It reports the verdict back rather than filing it silently. An explicit check
// you asked for should tell you what it found; sorting still follows the mode.
const VERDICT_LABEL = {
  business_spam: "Business spam",
  phishing: "Possible phishing",
  legitimate: "Looks legitimate",
};

async function scanOnDemand(msgs) {
  if (!msgs.length) return;
  const items = msgs.map((m) => ({
    id: m.id, headerMessageId: m.headerMessageId, account: m.folder?.accountId,
  }));
  await enqueue(items);

  const r = await drainQueue({ manual: true });
  if (r?.skipped === "already-running") {
    notify("Mail Triage", `A batch is running — ${msgs.length === 1 ? "that message is" : "those are"} queued and will be scanned next.`);
    return;
  }
  if (r?.skipped) return;   // drainQueue already explained ollama-down / model-missing

  const verdicts = await getVerdicts();
  if (msgs.length === 1) {
    const v = verdicts[msgs[0].headerMessageId];
    if (!v) return void notify("Mail Triage", "That message could not be scanned.");
    const label = VERDICT_LABEL[v.category] || v.category;
    const pct = Math.round((v.confidence || 0) * 100);
    notify(`${label} — ${pct}% confident`, v.reason || "No reason recorded.");
    return;
  }
  const flagged = msgs.filter((m) => {
    const c = verdicts[m.headerMessageId]?.category;
    return c === "business_spam" || c === "phishing";
  }).length;
  notify("Mail Triage", `Scanned ${msgs.length} messages — ${flagged} flagged.`);
}

// The callback swallows the duplicate-id error when init() runs again on startup.
browser.menus.create({
  id: "triage-scan-now",
  title: "Scan with Mail Triage",
  contexts: ["message_list"],
}, () => void browser.runtime.lastError);

browser.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "triage-scan-now") return;
  const sel = info.selectedMessages;
  if (!sel) return;
  let msgs = sel.messages || [];
  let page = sel;
  while (page?.id) {
    page = await browser.messages.continueList(page.id).catch(() => null);
    if (!page?.messages?.length) break;
    msgs = msgs.concat(page.messages);
  }
  try { await scanOnDemand(msgs); }
  catch (e) { await recordBackgroundError("scan on demand", e); }
});

// A rescue: you moved something OUT of Look At Later. That is a false positive,
// so allow-list the sender and record it as a counter-example for the prompt.
browser.messages.onMoved.addListener(async (originals, moved) => {
  const s = await getSettings();
  for (let i = 0; i < originals.messages.length; i++) {
    const before = originals.messages[i];
    const after = moved.messages[i];
    if (!before || !after) continue;
    const src = before.folder?.name, dst = after.folder?.name;
    if (src !== s.folderName || dst === s.folderName) continue;
    if (after.folder?.specialUse?.some((u) => ["trash", "junk"].includes(u))) continue; // not a rescue
    await learnRescue(after.id, before.headerMessageId, "moved back manually");
  }
});

async function learnRescue(msgId, headerMessageId, why) {
  try {
    const hdr = await browser.messages.get(msgId);
    const full = await browser.messages.getFull(msgId);
    const keys = identityKeys(hdr, full);
    const rec = (await getVerdicts())[headerMessageId];
    const key = await AL.allow(keys, { reason: why, sample: hdr.subject });
    await AL.addCorrection({
      kind: "false_positive", was: rec?.category || "flagged",
      from: emailAddress(hdr.author), subject: hdr.subject,
    });
    await updateVerdict(headerMessageId, { userVerdict: "wrong", rescuedAt: Date.now(), allowKey: key });
    // Clear our tags so the message looks untouched again.
    const tags = (hdr.tags || []).filter((t) => t !== TAGS.business_spam.key && t !== TAGS.phishing.key);
    await browser.messages.update(msgId, { tags });
    log("rescued -> allow-listed", key);
  } catch (e) { log("learnRescue failed", e.message); }
}

// You dragging something INTO Look At Later is a miss the model should learn from.
browser.messages.onMoved.addListener(async (originals, moved) => {
  const s = await getSettings();
  for (let i = 0; i < moved.messages.length; i++) {
    const after = moved.messages[i], before = originals.messages[i];
    if (!after || after.folder?.name !== s.folderName) continue;
    if (before?.folder?.name === s.folderName) continue;
    const known = (await getVerdicts())[after.headerMessageId];
    if (known?.action === "moved") continue; // we moved it, not the user
    await AL.addCorrection({
      kind: "false_negative", should: "business_spam",
      from: emailAddress(after.author), subject: after.subject,
    });
    log("learned miss:", after.subject);
  }
});

// Correcting a verdict directly from a message. Works whether or not the message
// was ever classified, and whether or not you already judged it in the report —
// changing your mind has to be possible, or the first answer is permanent.
async function trustSender(msgId, headerMessageId) {
  const hdr = await browser.messages.get(msgId);
  const full = await browser.messages.getFull(msgId);
  const keys = identityKeys(hdr, full);
  const rec = (await getVerdicts())[headerMessageId];

  const key = await AL.allow(keys, { reason: "marked not spam by you", sample: hdr.subject });
  await AL.addCorrection({
    kind: "false_positive", was: rec?.category || "unclassified",
    from: emailAddress(hdr.author), subject: hdr.subject,
  });
  await putVerdict({
    headerMessageId, ts: rec?.ts || Date.now(), account: rec?.account || hdr.folder?.accountId,
    from: emailAddress(hdr.author), subject: hdr.subject,
    category: "legitimate", confidence: 1, evidence: [],
    reason: rec ? `you corrected this: was ${rec.category}` : "you marked this sender trusted",
    action: rec?.action === "moved" ? "moved" : "left",
    userVerdict: "wrong", rescuedAt: Date.now(), allowKey: key, keys,
  });

  // Clear our tags so the message looks untouched again.
  const tags = (hdr.tags || []).filter((t) => t !== TAGS.business_spam.key && t !== TAGS.phishing.key);
  await browser.messages.update(msgId, { tags }).catch(() => {});

  // If it had been moved, put it back where it belongs.
  const s = await getSettings();
  if (hdr.folder?.name === s.folderName) {
    const acct = (await browser.accounts.list(false)).find((a) => a.id === hdr.folder.accountId);
    const inbox = acct ? await inboxOf(acct) : null;
    if (inbox) await browser.messages.move([msgId], inbox.id).catch(() => {});
  }
  log("trusted", key);
  return { key };
}

// The reverse: something the model let through that you consider spam.
async function markSpam(msgId, headerMessageId) {
  const hdr = await browser.messages.get(msgId);
  const rec = (await getVerdicts())[headerMessageId];
  const s = await getSettings();

  await AL.addCorrection({
    kind: "false_negative", should: "business_spam",
    from: emailAddress(hdr.author), subject: hdr.subject,
  });
  // Trusting a sender then reporting them as spam should undo the trust.
  if (rec?.allowKey) await AL.revoke(rec.allowKey);

  const tags = [...new Set([...(hdr.tags || []), TAGS.business_spam.key])];
  await browser.messages.update(msgId, { tags }).catch(() => {});

  let action = "tagged";
  if (s.mode !== "shadow") {
    const acct = (await browser.accounts.list(false)).find((a) => a.id === hdr.folder?.accountId);
    const dest = acct ? await triageFolderOf(acct) : null;
    if (dest) { await browser.messages.move([msgId], dest.id); action = "moved"; }
  }
  await putVerdict({
    headerMessageId, ts: rec?.ts || Date.now(), account: hdr.folder?.accountId,
    from: emailAddress(hdr.author), subject: hdr.subject,
    category: "business_spam", confidence: 1, evidence: [],
    reason: "you marked this as spam", action, userVerdict: "agree",
  });
  log("marked spam:", hdr.subject);
  return { action };
}

// Discard the model's verdicts so mail can be judged again — after a classifier fix,
// for example. Deliberately keeps the allow-list and the correction history: those are
// YOUR judgements, and re-earning them would waste the review work already done.
//
// Tags are cleared alongside, otherwise tags from the discarded run survive with
// nothing recording why they are there.
async function resetVerdicts({ untag = true, keepReviewed = false } = {}) {
  const verdicts = await getVerdicts();
  let kept = 0;

  // Stash what is about to go, so a clear is undoable without depending on the
  // user having taken an export first.
  await browser.storage.local.set({
    verdictsBackup: { at: Date.now(), count: Object.keys(verdicts).length, verdicts },
  });

  if (keepReviewed) {
    // Preserve rows you personally judged, so precision history is not lost.
    const next = {};
    for (const [k, v] of Object.entries(verdicts)) {
      if (v.userVerdict) { next[k] = v; kept++; }
    }
    await browser.storage.local.set({ verdicts: next });
  } else {
    await browser.storage.local.set({ verdicts: {} });
  }

  let untagged = 0;
  if (untag) {
    const keys = [TAGS.business_spam.key, TAGS.phishing.key];
    try {
      const q = await browser.messages.query({
        tags: { mode: "any", tags: Object.fromEntries(keys.map((k) => [k, true])) },
        autoPaginationTimeout: 0,
      });
      let page = q;
      while (page) {
        for (const m of page.messages) {
          const tags = (m.tags || []).filter((t) => !keys.includes(t));
          await browser.messages.update(m.id, { tags }).catch(() => {});
          untagged++;
        }
        if (!page.id) break;
        page = await browser.messages.continueList(page.id).catch(() => null);
        if (page && !page.messages.length) break;
      }
    } catch (e) {
      log("untag failed:", e.message);
    }
  }

  await browser.storage.local.set({ queue: [] });
  const allow = Object.keys(await AL.getAllow()).length;
  const corr = (await AL.getCorrections()).length;
  log(`reset: cleared verdicts (kept ${kept}), untagged ${untagged}, ` +
      `preserved ${allow} allow-list entries and ${corr} corrections`);
  return { kept, untagged, allowKept: allow, correctionsKept: corr };
}

// Repair for a defect in versions up to 0.1.18: the report's Agree button called
// markSpam instead of confirm. Agreeing with a verdict therefore rewrote it to
// business_spam and logged a correction claiming the model had MISSED the message,
// when it had in fact been right. Those corrections are fed back into the prompt as
// examples, so leaving them in place teaches the classifier the opposite of the truth.
//
// Both effects are identifiable: the corrections are false_negative entries, and the
// verdicts carry the reason "you marked this as spam". Affected verdicts are removed
// rather than guessed at, so the messages are simply classified again.
async function repairAgreeBug() {
  const corrections = await AL.getCorrections();
  const keptCorrections = corrections.filter((c) => c.kind !== "false_negative");
  const droppedCorrections = corrections.length - keptCorrections.length;
  await browser.storage.local.set({ corrections: keptCorrections });

  const verdicts = await getVerdicts();
  const next = {};
  let droppedVerdicts = 0;
  for (const [k, v] of Object.entries(verdicts)) {
    if (v.reason === "you marked this as spam") { droppedVerdicts++; continue; }
    next[k] = v;
  }
  await browser.storage.local.set({ verdicts: next });

  // Clear the spam tag from anything the bug tagged, so those messages look untouched.
  let untagged = 0;
  try {
    let page = await browser.messages.query({
      tags: { mode: "any", tags: { [TAGS.business_spam.key]: true } },
      autoPaginationTimeout: 0,
    });
    while (page) {
      for (const m of page.messages) {
        if (verdicts[m.headerMessageId]?.reason !== "you marked this as spam") continue;
        await browser.messages.update(m.id, {
          tags: (m.tags || []).filter((t) => t !== TAGS.business_spam.key),
        }).catch(() => {});
        untagged++;
      }
      if (!page.id) break;
      page = await browser.messages.continueList(page.id).catch(() => null);
      if (page && !page.messages.length) break;
    }
  } catch (e) { log("repair untag failed:", e.message); }

  const allow = Object.keys(await AL.getAllow()).length;
  log(`repair: dropped ${droppedCorrections} bogus correction(s), ${droppedVerdicts} verdict(s), ` +
      `untagged ${untagged}; allow-list untouched (${allow} entries)`);
  return { droppedCorrections, droppedVerdicts, untagged, allowKept: allow };
}

// ---- reconciliation ----------------------------------------------------
// onMoved only fires for moves Thunderbird performs. A rescue done on your phone
// arrives as a silent IMAP change, so periodically check what left the folder.

async function reconcile() {
  const s = await getSettings();
  const verdicts = await getVerdicts();
  const expected = Object.entries(verdicts).filter(([, r]) => r.action === "moved" && !r.rescuedAt);
  if (!expected.length) return 0;

  const present = new Set();
  for (const acct of await watchedAccounts()) {
    const f = await triageFolderOf(acct, false);
    if (!f) continue;
    let page = await browser.messages.query({ folderId: f.id, autoPaginationTimeout: 0 });
    while (page) {
      for (const m of page.messages) present.add(m.headerMessageId);
      page = page.id ? await browser.messages.continueList(page.id).catch(() => null) : null;
      if (page && !page.messages.length) break;
    }
  }

  let learned = 0;
  for (const [hmid, rec] of expected) {
    if (present.has(hmid)) continue;
    // Gone from the folder and we did not move it out — you rescued it elsewhere.
    await updateVerdict(hmid, { userVerdict: "wrong", rescuedAt: Date.now(), rescuedVia: "reconcile" });
    await AL.addCorrection({ kind: "false_positive", was: rec.category, from: rec.from, subject: rec.subject });
    if (rec.keys?.length) await AL.allow(rec.keys, { reason: "rescued on another device", sample: rec.subject });
    learned++;
  }
  if (learned) log("reconcile: learned", learned, "off-device rescue(s)");
  return learned;
}

// ---- graduation --------------------------------------------------------
// Only ever a suggestion. The add-on never changes its own mode.

async function maybeOfferGraduation() {
  const s = await getSettings();
  if (s.mode !== "shadow" || s.graduationOffered) return;
  const st = await stats();
  if (st.reviewed < s.graduateMinReviewed) return;
  if (st.precision === null || st.precision < s.graduateMinPrecision) return;
  await setSettings({ graduationOffered: true });
  notify("Ready to graduate from shadow mode",
    `${(st.precision * 100).toFixed(1)}% precision over ${st.reviewed} reviewed. ` +
    `Open Mail Triage options to enable moving.`);
}

function notify(title, message) {
  browser.notifications.create({ type: "basic", title, message,
    iconUrl: browser.runtime.getURL("icons/icon-64.png") }).catch(() => {});
}

// ---- daily report ------------------------------------------------------

// The daily report is the one path that runs with nobody watching, and it fails
// silently by construction: lastReportDate is only written on success, so a throw
// anywhere above it means the alarm retries and fails again every 30 minutes
// forever, leaving no trace. Record the failure — and which stage it died in —
// somewhere that can actually be read: the report page's error box.
async function recordBackgroundError(where, err) {
  try {
    const { backgroundErrors = [] } = await browser.storage.local.get("backgroundErrors");
    backgroundErrors.push(`${new Date().toLocaleString()}  ${where}: ${err?.message || err}`);
    await browser.storage.local.set({ backgroundErrors: backgroundErrors.slice(-20) });
  } catch { /* if storage itself is failing there is nothing left to try */ }
}

async function dailyReport(force = false) {
  const s = await getSettings();
  const today = localDay();
  if (!force && s.lastReportDate === today) return;

  let stage = "rendering";
  try {
    const html = await renderReport(today);
    stage = "emailing";
    if (s.emailReport && s.reportEmail) await sendReportEmail(s, today, html);
    stage = "recording";
    await setSettings({ lastReportDate: today });
    // A run that succeeds clears the record, so a fixed fault stops looking broken.
    await browser.storage.local.set({ backgroundErrors: [] });
    log("daily report sent for", today);
  } catch (e) {
    await recordBackgroundError(`daily report (${stage})`, e);
    log(`daily report failed while ${stage}:`, e?.message || e);
    if (force) throw e;   // a manual run should surface it in the page that asked
  }
}

// ---- wiring ------------------------------------------------------------

browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("ui/report.html") });
});

browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg.cmd) {
    case "sortNow":    return drainQueue({ manual: true });
    case "scanInbox":  return scanInboxes(msg.days ?? 1, { dryRun: msg.dryRun });
    case "queueDepth": return { pending: (await getQueue()).length, running: draining };
    case "stopDrain":  { stopRequested = true; return { stopping: true }; }
    case "reconcile":  return reconcile();
    case "report":     return dailyReport(true);
    case "stats":      return stats();
    case "health":     { const s = await getSettings();
                         const o = new Ollama(s.endpoint, s.model);
                         return { health: await o.health(), loaded: await o.loaded() }; }
    case "rescue":     return learnRescue(msg.id, msg.headerMessageId, "marked Wrong in report");
    case "confirm":    return updateVerdict(msg.headerMessageId, { userVerdict: "agree" });
    case "sweepBacklog": return sweepBacklog();
    case "resetVerdicts": return resetVerdicts(msg.opts || {});
    case "repairAgreeBug": return repairAgreeBug();
    case "undoReset": {
      const s = await browser.storage.local.get("verdictsBackup");
      if (!s.verdictsBackup) return { restored: 0 };
      const cur = await getVerdicts();
      // Merge, so anything classified since the clear is not thrown away in turn.
      await browser.storage.local.set({ verdicts: { ...s.verdictsBackup.verdicts, ...cur } });
      return { restored: s.verdictsBackup.count, at: s.verdictsBackup.at };
    }
    case "resetInfo": {
      const s = await browser.storage.local.get("verdictsBackup");
      return s.verdictsBackup
        ? { at: s.verdictsBackup.at, count: s.verdictsBackup.count } : null;
    }
    case "verdictFor": {
      const v = (await getVerdicts())[msg.headerMessageId] || null;
      let keys = v?.keys || [];
      if (!keys.length && msg.id != null) {
        try {
          const hdr = await browser.messages.get(msg.id);
          keys = identityKeys(hdr, await browser.messages.getFull(msg.id));
        } catch { /* message may be gone */ }
      }
      return { verdict: v, keys };
    }
    case "trustSender": return trustSender(msg.id, msg.headerMessageId);
    case "markSpam":    return markSpam(msg.id, msg.headerMessageId);
    case "folders":    return foldersStatus();
    case "makeFolders": {
      for (const a of await watchedAccounts()) await triageFolderOf(a, true).catch(() => null);
      return foldersStatus();
    }
  }
});

// Pull in inbox mail the add-on has never seen: messages that predate installation,
// or arrived while Thunderbird was closed. days = 0 means the entire inbox.
//
// Paginated, because an inbox of several thousand messages will not come back in a
// single query, and skipping already-classified messages keeps a re-run cheap.
async function scanInboxes(days = 1, { dryRun = false } = {}) {
  const since = days > 0 ? new Date(Date.now() - days * 86400000) : null;
  const verdicts = await getVerdicts();
  const queued = [];
  let scanned = 0;

  for (const acct of await watchedAccounts()) {
    const inbox = await inboxOf(acct);
    if (!inbox) continue;
    const q = { folderId: inbox.id, autoPaginationTimeout: 0 };
    if (since) q.fromDate = since;

    let page = await browser.messages.query(q);
    while (page) {
      scanned += page.messages.length;
      for (const m of page.messages) {
        if (verdicts[m.headerMessageId]) continue;
        queued.push({ id: m.id, headerMessageId: m.headerMessageId, account: acct.id });
      }
      if (!page.id) break;
      page = await browser.messages.continueList(page.id).catch(() => null);
      if (page && !page.messages.length) break;
    }
  }

  // Roughly 2.5s per message on a mid-range GPU; enough to decide whether to start.
  const estimate = Math.round((queued.length * 2.5) / 60);
  if (dryRun) return { scanned, pending: queued.length, estimateMinutes: estimate };

  const n = await enqueue(queued);
  if (n) drainQueue();
  return { scanned, queued: n, estimateMinutes: estimate };
}

// On graduating to full mode: move everything still tagged that you did not mark Wrong.
async function sweepBacklog() {
  const s = await getSettings();
  const verdicts = await getVerdicts();
  let moved = 0;
  for (const [hmid, rec] of Object.entries(verdicts)) {
    if (!String(rec.action || "").startsWith("tagged")) continue;
    if (rec.userVerdict === "wrong") continue;
    const found = await browser.messages.query({ headerMessageId: hmid });
    const m = found.messages[0];
    if (!m) continue;
    const acct = (await browser.accounts.list(false)).find((a) => a.id === rec.account);
    const dest = acct ? await triageFolderOf(acct) : null;
    if (!dest) continue;
    await browser.messages.move([m.id], dest.id);
    await updateVerdict(hmid, { action: "moved", sweptAt: Date.now() });
    moved++;
  }
  return { moved };
}

async function init() {
  await ensureTags();
  const missing = [];
  for (const a of await watchedAccounts()) {
    const f = await triageFolderOf(a).catch((e) => { log("folder", a.name, e.message); return null; });
    if (!f) missing.push(a.name);
  }
  if (missing.length) {
    notify("Mail Triage: no destination folder",
      `Could not create "${(await getSettings()).folderName}" for: ${missing.join(", ")}. ` +
      `Those accounts will be tagged but never moved.`);
  }
  browser.alarms.create("drain",     { periodInMinutes: 10 });
  browser.alarms.create("reconcile", { periodInMinutes: 30 });
  browser.alarms.create("report",    { periodInMinutes: 30 });
  browser.alarms.create("prune",     { periodInMinutes: 1440 });
  log("initialised");
}

browser.alarms.onAlarm.addListener(async (a) => {
  const s = await getSettings();
  if (a.name === "drain")     return void drainQueue();
  if (a.name === "reconcile") return void reconcile();
  if (a.name === "prune")     return void pruneVerdicts(90);
  if (a.name === "report") {
    const now = new Date();
    if (now.getHours() >= s.reportHour) await dailyReport();
  }
});

browser.runtime.onInstalled.addListener(init);
browser.runtime.onStartup.addListener(init);
init();
