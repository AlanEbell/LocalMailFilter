// Structural checks on the UI scripts.
//
// A handler registered inside another handler is valid JavaScript and passes a
// syntax check, but only takes effect once the outer handler has run. That is how
// the export button came to do nothing: an edit injected a block at the first
// `load();`, which was inside the save handler, and every handler appended after
// it ended up nested there too.
//
// Also verifies that every element id the script addresses exists in its page, so
// a typo surfaces here rather than as a silently dead button.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || !detail ? "" : "\n         " + detail}`);
};

// --- handler registrations must be at column 0, in EVERY ui script ---
// Checking only options.js let the identical bug reappear in report.js hours later.
for (const script of ["options", "report"]) {
  const js = readFileSync(new URL(`../ui/${script}.js`, import.meta.url), "utf8").split("\n");
  const nested = [];
  js.forEach((line, i) => {
    const m = /^(\s*)on\("#/.exec(line);
    if (m && m[1].length > 0) nested.push(`line ${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  check(`every ${script}.js handler is registered at top level`,
        nested.length === 0, nested.join("\n         "));
}

// --- referenced ids must exist in the page, unless created at runtime ---
const RUNTIME_IDS = new Set(["fallback", "bkarea", "copyb", "saveb", "cstat"]);
for (const [script, page] of [["options", "options"], ["report", "report"]]) {
  const src = readFileSync(new URL(`../ui/${script}.js`, import.meta.url), "utf8");
  const html = readFileSync(new URL(`../ui/${page}.html`, import.meta.url), "utf8");
  const defined = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const used = new Set([...src.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !defined.has(u) && !RUNTIME_IDS.has(u));
  check(`${script}.js references only ids present in ${page}.html`,
        missing.length === 0, "missing: " + missing.join(", "));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
