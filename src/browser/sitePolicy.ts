import type { StageBrowserConfig } from "../types/stage.js";

export class BlockedSiteError extends Error {
  readonly code = "browser_site_blocked";

  constructor(message: string) {
    super(message);
    this.name = "BlockedSiteError";
  }
}

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

export function hostOf(urlOrHost: string): string | undefined {
  const text = urlOrHost.trim();
  if (text.length === 0) return undefined;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return parsed.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

function within(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isBlockedHost(host: string, blocked: readonly string[]): string | undefined {
  const h = normalizeDomain(host);
  return blocked.map(normalizeDomain).find((d) => d.length > 0 && within(h, d));
}

/** Throws when the stage's allow_domains or check URLs touch a Host-blocked site. */
export function assertBrowserSitesAllowed(
  stageId: string,
  browser: StageBrowserConfig,
  blocked: readonly string[],
): void {
  if (blocked.length === 0) return;
  const norm = blocked.map(normalizeDomain).filter((d) => d.length > 0);
  const fail = (site: string, where: string): never => {
    throw new BlockedSiteError(
      `Stage "${stageId}": browser ${where} "${site}" is blocked by Host policy (browser.blocked_sites)`,
    );
  };
  for (const entry of browser.allow_domains ?? []) {
    const d = normalizeDomain(entry);
    if (norm.some((b) => within(d, b) || within(b, d))) fail(entry, "allow_domains entry");
  }
  const urls = [
    ["login_url", browser.login_url],
    ["check.url", browser.check?.url],
    ["check.logged_in_url", browser.check?.logged_in_url],
    ...[browser.check?.logged_out_url].flat().map((u) => ["check.logged_out_url", u] as const),
  ] as const;
  for (const [where, url] of urls) {
    if (!url) continue;
    const host = hostOf(url);
    if (host !== undefined && isBlockedHost(host, norm) !== undefined) fail(host, where);
  }
}
