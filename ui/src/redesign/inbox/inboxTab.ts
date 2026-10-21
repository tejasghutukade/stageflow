export type InboxTabId = "needs" | "failed" | "done_today";

const INBOX_TAB_IDS: InboxTabId[] = ["needs", "failed", "done_today"];

function parseInboxTabParam(raw: string | null): InboxTabId {
  if (raw && (INBOX_TAB_IDS as string[]).includes(raw) && raw !== "needs") {
    return raw as InboxTabId;
  }
  return "needs";
}

export function parseInboxTabFromHash(hash = window.location.hash): InboxTabId {
  const stripped = hash.replace(/^#\/?/, "");
  const q = stripped.indexOf("?");
  if (q < 0) return "needs";
  const path = stripped.slice(0, q);
  if (path !== "inbox") return "needs";
  const params = new URLSearchParams(stripped.slice(q + 1));
  return parseInboxTabParam(params.get("tab"));
}

export function inboxPath(tab: InboxTabId = "needs"): string {
  if (tab === "needs") return "/inbox";
  return `/inbox?tab=${encodeURIComponent(tab)}`;
}

export function replaceInboxTabInHash(tab: InboxTabId): void {
  const next = inboxPath(tab);
  if (window.location.hash.replace(/^#/, "") !== next) {
    window.location.hash = next;
  }
}
