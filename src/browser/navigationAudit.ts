import type { StageLogEvent } from "../runstore/port.js";
import { type AuditSink, safeAudit } from "./auditSink.js";
import { hostOf, normalizeDomain } from "./sitePolicy.js";

export type NavigationPolicy = {
  runId: string;
  stageId: string;
  profile?: string;
  allow_domains: string[];
};

const NAV_COMMAND =
  /\bagent-browser\b[^\n|;&]*?\s(?:open|goto|navigate|tab\s+new)\s+(?:--?\S+\s+)*["']?([^\s"'|;&]+)/g;

function allowed(host: string, allow: readonly string[]): boolean {
  return allow.some((entry) => {
    const d = normalizeDomain(entry);
    return host === d || host.endsWith(`.${d}`);
  });
}

/**
 * Soft allowlist check for profile stages (agent-browser refuses
 * --allowed-domains with --profile). The only cheap signal is the persisted
 * bash tool activity: it sees explicit `agent-browser open|goto|navigate <url>`
 * commands, not redirects, link clicks or in-page navigation. Hosts only are
 * recorded, never full URLs.
 */
export async function auditStageNavigations(
  policy: NavigationPolicy,
  events: (() => Promise<StageLogEvent[]>) | undefined,
  sink: AuditSink | undefined,
): Promise<void> {
  if (policy.allow_domains.length === 0) return;
  const base = {
    runId: policy.runId,
    stageId: policy.stageId,
    ...(policy.profile !== undefined ? { profile: policy.profile } : {}),
  };
  let log: StageLogEvent[];
  try {
    if (events === undefined) throw new Error("no activity log available");
    log = await events();
  } catch {
    await safeAudit(sink, {
      event: "allowlist_unverified",
      ...base,
      reason: "stage activity log unavailable; navigations were not checked",
    });
    return;
  }
  const seen = new Set<string>();
  for (const event of log) {
    if (event.event !== "tool_start" || !event.argsPreview) continue;
    for (const match of event.argsPreview.matchAll(NAV_COMMAND)) {
      const host = hostOf(match[1] ?? "");
      if (host === undefined || allowed(host, policy.allow_domains)) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      await safeAudit(sink, { event: "navigation_outside_allowlist", ...base, host });
    }
  }
}
