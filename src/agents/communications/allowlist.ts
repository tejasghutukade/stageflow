/**
 * Who may message an agent over its channel. Entries are an email address, a phone number
 * (E.164), `@domain` for everyone at a domain, a Slack user id (`U02ABC123`), a Telegram user id
 * (`123456789`) or `@username`, or `*` for anyone. An empty list lets nobody in.
 */

export const SENDER_ENTRY =
  /^(\*|@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+|\+[1-9]\d{6,14}|[UW][A-Z0-9]{7,}|[1-9]\d{4,14}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** "Jane Doe <Jane@X.com>" -> "jane@x.com"; phone numbers lose spaces, dashes and brackets. */
export function normalizeSender(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  const value = (angle ? angle[1]! : raw).trim();
  if (/^[+\d][\d\s().-]*$/.test(value)) return value.replace(/[\s().-]/g, "");
  return value.toLowerCase();
}

export function normalizeEntry(entry: string): string {
  return entry === "*" ? entry : normalizeSender(entry);
}

/** A dotless `@name`: a Telegram username. It can change hands, so it is weaker than the numeric user id. */
export function isUsernameEntry(entry: string): boolean {
  return entry.startsWith("@") && !entry.includes(".");
}

/**
 * Mail domains anyone can get an address at. An `@domain` entry for one of these lets in as many people as `*`.
 * The list is not complete; it covers the large providers.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "tutanota.com", "tuta.com", "hey.com", "qq.com", "163.com",
]);

/** The allow-list lets in anyone, or anyone with an address at a public mail provider. */
export function openToAnyone(allowFrom: readonly string[]): boolean {
  return allowFrom.some((entry) => {
    const allowed = normalizeEntry(entry);
    return allowed === "*" || (allowed.startsWith("@") && PUBLIC_MAIL_DOMAINS.has(allowed.slice(1)));
  });
}

/** `username` is the sender's current handle where the provider has one besides the stable id (Telegram). */
export function senderAllowed(allowFrom: readonly string[], sender: string | undefined, username?: string): boolean {
  if (allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  if (sender === undefined) return false;
  const who = normalizeSender(sender);
  const handle = username?.trim().toLowerCase();
  const domain = who.includes("@") ? who.slice(who.lastIndexOf("@")) : undefined;
  return allowFrom.some((entry) => {
    const allowed = normalizeEntry(entry);
    if (allowed === who) return true;
    if (!allowed.startsWith("@")) return false;
    // `@domain` matches everyone at it; a dotless `@name` is a Telegram username (senders arrive without the `@`).
    if (allowed.includes(".")) return domain === allowed;
    return who === allowed.slice(1) || handle === allowed.slice(1);
  });
}
