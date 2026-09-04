// Builds the "who is this mailbox" block for the classifier prompt.
//
// Everything that Thunderbird already knows — your addresses, display names, which
// accounts exist — is read straight from the account configuration. The only thing
// you are ever asked to supply is what a domain MEANS, which nothing on the machine
// can infer: that example.org is a volunteer club rather than a vendor, say.

const FREEMAIL = new Set([
  "gmail.com","googlemail.com","yahoo.com","hotmail.com","outlook.com","live.com",
  "msn.com","icloud.com","me.com","mac.com","aol.com","proton.me","protonmail.com",
  "gmx.com","mail.com","fastmail.com","zoho.com","yandex.com","hey.com",
]);

// Addresses like these are published on a website; strangers writing to them are
// customers, not cold outreach. Getting this wrong buries real revenue.
const ROLE_LOCALPARTS = new Set([
  "sales","info","contact","support","orders","enquiries","inquiries",
  "hello","help","service","billing","shop","store","bookings",
]);

export async function deriveIdentity() {
  const accounts = await browser.accounts.list(false);
  const seen = new Map();
  const names = new Map();

  for (const a of accounts) {
    for (const id of a.identities || []) {
      if (!id.email) continue;
      const email = id.email.toLowerCase();
      if (!seen.has(email)) seen.set(email, { email, accountName: a.name, accountId: a.id });
      if (id.name) names.set(id.name, (names.get(id.name) || 0) + 1);
    }
  }

  const addresses = [...seen.values()];
  // The display name you use most often is almost certainly your actual name.
  const ownerName = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  const domains = new Map();
  for (const a of addresses) {
    const d = a.email.slice(a.email.lastIndexOf("@") + 1);
    a.domain = d;
    a.isFreemail = FREEMAIL.has(d);
    a.isRole = ROLE_LOCALPARTS.has(a.email.slice(0, a.email.indexOf("@")));
    if (!a.isFreemail) domains.set(d, (domains.get(d) || 0) + 1);
  }

  return { ownerName, addresses, orgDomains: [...domains.keys()] };
}

// Assemble the prompt block. `notes` is the only human-written part: one line per
// domain saying what it is.
export async function buildOwnerBlock(notes = "") {
  const { ownerName, addresses, orgDomains } = await deriveIdentity();
  const lines = [];

  lines.push(ownerName
    ? `The mailbox owner is ${ownerName}.`
    : `The mailbox owner's name is not configured.`);

  if (addresses.length) {
    lines.push(`Their addresses (mail TO these is mail to the owner):`);
    for (const a of addresses) {
      const marks = [];
      if (a.isRole) marks.push("PUBLIC ROLE ADDRESS — strangers are supposed to write here; " +
                               "enquiries about products, prices, stock, orders or shipping " +
                               "sent to it are CUSTOMERS, never spam");
      lines.push(`  - ${a.email}${marks.length ? `  [${marks.join("; ")}]` : ""}`);
    }
  }

  if (orgDomains.length) {
    lines.push(`Domains the owner holds an address at — mail from these is internal ` +
               `correspondence, never spam: ${orgDomains.join(", ")}`);
  }

  const trimmed = (notes || "").trim();
  if (trimmed) {
    lines.push("", "What these are, in the owner's own words:", trimmed);
  }

  return lines.join("\n");
}

// A starting point for the notes box: one blank line per domain the owner actually
// has an address at, so there is nothing to type from scratch.
export async function suggestNotes() {
  const { orgDomains } = await deriveIdentity();
  if (!orgDomains.length) return "";
  return orgDomains.map((d) => `- ${d} — `).join("\n");
}
