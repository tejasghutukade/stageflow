import type { StageBrowserConfig } from "../types/stage.js";

export type GateHandoff =
  | { kind: "local_window" }
  | { kind: "live_view"; url: string };

/** Host-owned fields on a gate prompt for stages with a `browser`. Never a path. */
export type HostGateContext = {
  handoff?: GateHandoff;
  site?: string;
  profile?: string;
};

export const HOST_GATE_KEYS = ["handoff", "site", "profile"] as const;

export function parseGateHandoff(value: unknown): GateHandoff | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "local_window") return { kind: "local_window" };
  if (record.kind === "live_view" && typeof record.url === "string") {
    if (isRootRelativePath(record.url)) return { kind: "live_view", url: record.url };
    try {
      const url = new URL(record.url);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return { kind: "live_view", url: record.url };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isRootRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

/** Reads the Host-owned fields off a stored or live wait request; unknown shapes yield nothing. */
export function parseHostGateContext(value: unknown): HostGateContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const handoff = parseGateHandoff(record.handoff);
  return {
    ...(handoff !== undefined ? { handoff } : {}),
    ...(typeof record.site === "string" && record.site !== ""
      ? { site: record.site }
      : {}),
    ...(typeof record.profile === "string" && record.profile !== ""
      ? { profile: record.profile }
      : {}),
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function browserSite(browser: StageBrowserConfig): string | undefined {
  if (browser.check !== undefined) {
    const host = hostOf(browser.check.url);
    if (host !== undefined) return host;
  }
  const first = browser.allow_domains?.[0];
  if (first !== undefined) return first.replace(/^\*\./, "");
  if (browser.login_url !== undefined) return hostOf(browser.login_url);
  return undefined;
}

/**
 * Overwrites (or, for stages without a browser, strips) the Host-owned keys of
 * a wait request. Non-object requests pass through unchanged.
 */
export function stampGateRequest(
  request: unknown,
  context: HostGateContext | undefined,
): unknown {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return request;
  }
  const next: Record<string, unknown> = { ...(request as Record<string, unknown>) };
  for (const key of HOST_GATE_KEYS) delete next[key];
  return context === undefined ? next : { ...next, ...context };
}
