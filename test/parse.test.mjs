import { parseVerdict } from "../lib/ollama.js";
let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${n}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}`);
};

// Intact response parses normally.
const good = JSON.stringify({category:"phishing",evidence:["a"],confidence:0.9,reason:"r"});
eq("valid JSON parses", parseVerdict(good).category, "phishing");
eq("valid JSON is not marked truncated", parseVerdict(good).truncated, undefined);

// The exact failure seen in production: cut off mid-string.
const cut = '{"category": "business_spam", "evidence": ["The sender is a bulk marketing service with no prior relationship to the owner", "The message contains a List-Unsub';
const r = parseVerdict(cut);
eq("truncated response recovers the category", r.category, "business_spam");
eq("truncated response is flagged", r.truncated, true);
eq("recovers usable evidence", r.evidence.length > 0, true);
eq("reason notes the truncation", /truncated/.test(r.reason), true);

// Truncated before the category is unrecoverable and must still throw.
let threw = false;
try { parseVerdict('{"evi'); } catch { threw = true; }
eq("throws when the category never arrived", threw, true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
