// Turns a Thunderbird message into the text the model sees, and pulls out the
// forgery-resistant identity keys the allow-list is built on.

const BULK_INFRA = new Set([
  "gmail.com","googlemail.com","yahoo.com","hotmail.com","outlook.com","live.com",
  "icloud.com","me.com","aol.com","proton.me","protonmail.com","gmx.com","mail.com",
  "sendgrid.net","mailchimp.com","mcsv.net","mandrillapp.com","amazonses.com",
  "mailgun.org","sparkpostmail.com","mktomail.com","hubspotemail.net","salesforce.com",
  "constantcontact.com","cmail19.com","cmail20.com","createsend.com","klaviyomail.com",
  "sendinblue.com","brevo.com","postmarkapp.com","mailjet.com","zoho.com","substack.com",
]);

function headerValue(full, name) {
  const h = full?.headers?.[name.toLowerCase()];
  return Array.isArray(h) ? h[0] : h || "";
}

export function emailAddress(str) {
  if (!str) return "";
  const m = String(str).match(/<([^>]+)>/);
  return (m ? m[1] : String(str)).trim().toLowerCase();
}

function domainOf(addr) {
  const i = addr.lastIndexOf("@");
  return i === -1 ? "" : addr.slice(i + 1).toLowerCase();
}

// The DKIM signing domain is the one identity a spoofer cannot forge, so it is
// the preferred allow-list key.
export function dkimDomain(full) {
  const ar = headerValue(full, "authentication-results");
  const ds = headerValue(full, "dkim-signature");
  let m = /dkim=pass[^;]*?\bheader\.d=([A-Za-z0-9.\-]+)/i.exec(ar) ||
          /dkim=pass[^;]*?\bd=([A-Za-z0-9.\-]+)/i.exec(ar);
  if (m) return m[1].toLowerCase();
  if (/dkim=pass/i.test(ar)) {
    m = /\bd=([A-Za-z0-9.\-]+)/i.exec(ds);
    if (m) return m[1].toLowerCase();
  }
  return "";
}

// Identity keys in descending order of trustworthiness. The allow-list stores whichever
// is available; a domain key is only permitted when it is not shared bulk infrastructure.
export function identityKeys(hdr, full) {
  const from = emailAddress(hdr.author);
  const keys = [];
  const dkim = dkimDomain(full);
  if (dkim && !BULK_INFRA.has(dkim)) keys.push(`dkim:${dkim}`);
  const listId = headerValue(full, "list-id").replace(/.*<([^>]+)>.*/, "$1").trim().toLowerCase();
  if (listId) keys.push(`list:${listId}`);
  if (from) keys.push(`from:${from}`);
  const fd = domainOf(from);
  if (fd && !BULK_INFRA.has(fd) && fd === dkim) keys.push(`domain:${fd}`);
  return keys;
}

function flattenBody(part, out) {
  if (!part) return out;
  if (part.body && (!part.contentType || part.contentType.startsWith("text/"))) {
    out.push({ type: part.contentType || "text/plain", body: part.body });
  }
  for (const p of part.parts || []) flattenBody(p, out);
  return out;
}

function stripHtml(s) {
  return s.replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/\s+/g, " ").trim();
}

// Link display-text vs real href mismatch is the strongest single phishing signal,
// so surface it explicitly rather than hoping the model spots it in raw HTML.
function linkReport(htmlParts, limit = 8) {
  const seen = new Map();
  for (const p of htmlParts) {
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(p.body)) && seen.size < limit) {
      const href = m[1].trim();
      if (!/^https?:/i.test(href)) continue;
      const text = stripHtml(m[2]).slice(0, 60);
      let host = "";
      try { host = new URL(href).hostname.toLowerCase(); } catch { continue; }
      if (!seen.has(host)) seen.set(host, text);
    }
  }
  return [...seen.entries()].map(([h, t]) => `  ${h}${t ? `  (shown as: "${t}")` : ""}`);
}

export function buildPrompt(hdr, full, bodyChars) {
  const parts = flattenBody(full, []);
  const plain = parts.filter((p) => p.type.startsWith("text/plain"));
  const html = parts.filter((p) => p.type.startsWith("text/html"));
  let body = plain.length ? plain.map((p) => p.body).join("\n")
                          : stripHtml(html.map((p) => p.body).join("\n"));
  body = body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, bodyChars);

  const ar = headerValue(full, "authentication-results");
  const dkim = dkimDomain(full);
  const from = emailAddress(hdr.author);
  const fd = domainOf(from);

  const lines = [
    `From: ${hdr.author}`,
    `To: ${(hdr.recipients || []).join(", ")}`,
    `Subject: ${hdr.subject}`,
    `Date: ${hdr.date}`,
  ];
  const reply = headerValue(full, "reply-to");
  if (reply) {
    const ra = emailAddress(reply);
    lines.push(`Reply-To: ${reply}${domainOf(ra) !== fd ? "   [differs from From domain]" : ""}`);
  }
  const listId = headerValue(full, "list-id");
  if (listId) lines.push(`List-Id: ${listId}`);
  if (headerValue(full, "list-unsubscribe")) lines.push(`List-Unsubscribe: present (bulk sender)`);
  if (ar) {
    lines.push(`Authentication-Results: ${ar.slice(0, 300)}`);
    lines.push(dkim
      ? `DKIM signing domain: ${dkim}${dkim !== fd ? `   [does NOT match From domain ${fd}]` : "   [matches From domain]"}`
      : `DKIM: no passing signature`);
  }
  const links = linkReport(html);
  if (links.length) lines.push(`Links in body (real host, then displayed text):\n${links.join("\n")}`);

  return `${lines.join("\n")}\n\n--- body (first ${bodyChars} chars) ---\n${body}`;
}
