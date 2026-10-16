/**
 * Who may message an agent over its channel. Entries are an email address, a phone number
 * (E.164), `@domain` for everyone at a domain, or `*` for anyone. An empty list lets nobody in.
 */

export const SENDER_ENTRY = /^(\*|@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+|\+[1-9]\d{6,14})$/;

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

export function senderAllowed(allowFrom: readonly string[], sender: string | undefined): boolean {
  if (allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  if (sender === undefined) return false;
  const who = normalizeSender(sender);
  const domain = who.includes("@") ? who.slice(who.lastIndexOf("@")) : undefined;
  return allowFrom.some((entry) => {
    const allowed = normalizeEntry(entry);
    return allowed === who || (allowed.startsWith("@") && domain === allowed);
  });
}
