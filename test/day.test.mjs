// The report showed nothing after 20:00 EDT because the day it asked for was the
// UTC date while the window it filtered was local. These run under a forced
// timezone so the failure is reproducible rather than dependent on when tests run.

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function windowFor(day) {
  const [y, m, d] = day.split("-").map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

let pass = 0, fail = 0;
const check = (n, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${ok ? "" : "  " + detail}`);
};

// 2026-09-04 22:46 local — the exact moment the bug was observed.
const evening = new Date(2026, 8, 4, 22, 46, 0);
check("evening local day is the local date, not the UTC one",
      localDay(evening) === "2026-09-04", localDay(evening));

const [s, e] = windowFor(localDay(evening));
check("a verdict written at that moment falls inside its own day's window",
      evening.getTime() >= s && evening.getTime() < e);

// Boundaries.
const justBefore = new Date(2026, 8, 4, 23, 59, 59);
const justAfter  = new Date(2026, 8, 5, 0, 0, 1);
check("23:59:59 belongs to that day", localDay(justBefore) === "2026-09-04");
check("00:00:01 belongs to the next", localDay(justAfter) === "2026-09-05");
check("the window excludes the next day", justAfter.getTime() >= e);

// A DST transition must not produce a 25-hour or 23-hour hole.
const dstDay = "2026-11-01";           // US clocks go back
const [ds, de] = windowFor(dstDay);
check("a DST day still spans one calendar day", de > ds && (de - ds) >= 23 * 3600000);

// Single-digit months and days must stay zero-padded.
check("zero padding", localDay(new Date(2026, 0, 5)) === "2026-01-05",
      localDay(new Date(2026, 0, 5)));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
