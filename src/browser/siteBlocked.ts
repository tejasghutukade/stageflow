/** The phrase a browser stage puts at the start of a failure summary when a site refused its browser (see the browser skill). */
export const SITE_BLOCKED_MARKER = "site blocked this browser";

export function isSiteBlockedReport(summary: unknown): boolean {
  return typeof summary === "string" && summary.trim().toLowerCase().includes(SITE_BLOCKED_MARKER);
}
