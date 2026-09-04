import { dkimDomain, identityKeys, emailAddress, buildPrompt } from "../lib/extract.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};

const msg = (headers, parts) => ({ headers, parts });

// --- DKIM extraction ---
eq("dkim from header.d",
  dkimDomain(msg({"authentication-results":["mx.google.com; dkim=pass header.d=chase.com header.i=@chase.com; spf=pass"]})),
  "chase.com");
eq("dkim from bare d=",
  dkimDomain(msg({"authentication-results":["dkim=pass d=club.example; spf=pass"]})),
  "club.example");
eq("dkim fail yields nothing",
  dkimDomain(msg({"authentication-results":["dkim=fail header.d=evil.com; spf=fail"]})),
  "");
eq("no auth header yields nothing", dkimDomain(msg({})), "");

// --- identity key hierarchy ---
const hdr = (author, tags=[]) => ({ author, subject:"s", date:new Date(), recipients:[], tags });

eq("prefers DKIM domain over From",
  identityKeys(hdr("Chase <alerts@chase.com>"),
    msg({"authentication-results":["dkim=pass header.d=chase.com"]})),
  ["dkim:chase.com","from:alerts@chase.com","domain:chase.com"]);

eq("bulk infra NOT eligible as dkim key (sendgrid)",
  identityKeys(hdr("Newsletter <hi@marketing.example>"),
    msg({"authentication-results":["dkim=pass header.d=sendgrid.net"]})),
  ["from:hi@marketing.example"]);

eq("gmail sender gets exact address only, never domain",
  identityKeys(hdr("Diane <dkowalski27@gmail.com>"),
    msg({"authentication-results":["dkim=pass header.d=gmail.com"]})),
  ["from:dkowalski27@gmail.com"]);

eq("List-Id captured for newsletters",
  identityKeys(hdr("Weekly <news@bike.example>"),
    msg({"authentication-results":["dkim=pass header.d=bike.example"],
         "list-id":["Bicycling Weekly <news.bike.example>"]})),
  ["dkim:bike.example","list:news.bike.example","from:news@bike.example","domain:bike.example"]);

eq("spoofed From with mismatched DKIM keys on the real signer",
  identityKeys(hdr("Apple Support <no-reply@apple.com>"),
    msg({"authentication-results":["dkim=pass header.d=phisher-cdn.example"]})),
  ["dkim:phisher-cdn.example","from:no-reply@apple.com"]);

// --- address parsing ---
eq("angle brackets", emailAddress("Alan Bell <a@b.com>"), "a@b.com");
eq("bare address", emailAddress("a@b.com"), "a@b.com");
eq("case normalised", emailAddress("A@B.COM"), "a@b.com");

// --- prompt assembly: link mismatch must surface ---
const phish = msg(
  {"authentication-results":["dkim=none; spf=fail"], "reply-to":["billing@evil.example"]},
  [{contentType:"text/html", body:'<a href="http://evil-login.example/x">chase.com/login</a>'}]);
const out = buildPrompt(hdr("Chase <alerts@chase.com>"), phish, 500);
eq("surfaces real link host", out.includes("evil-login.example"), true);
eq("surfaces deceptive display text", out.includes('shown as: "chase.com/login"'), true);
eq("flags reply-to domain mismatch", out.includes("[differs from From domain]"), true);
eq("notes absent DKIM", out.includes("no passing signature"), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
