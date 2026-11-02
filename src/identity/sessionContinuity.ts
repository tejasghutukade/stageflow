import { boundedGet } from "./http.js";
import type { SessionProtection } from "./store.js";
import type { ConsumerAuthority } from "./types.js";

async function upstreamSubjectActive(url: string, issuer: string | null, subject: string, signal: AbortSignal): Promise<boolean> {
  if (!issuer) throw new Error("request_failed");
  const endpoint = new URL(url);
  const issuerUrl = new URL(issuer);
  if (endpoint.origin !== issuerUrl.origin || endpoint.username || endpoint.password) throw new Error("request_failed");
  endpoint.searchParams.set("subject", subject);
  const body = await boundedGet(endpoint, signal);
  if (typeof body !== "object" || body === null || typeof (body as { active?: unknown }).active !== "boolean") throw new Error("request_failed");
  return (body as { active: boolean }).active;
}

export type SessionContinuityOptions = {
  upstreamSubjectActive?: (url: string, issuer: string | null, subject: string, signal: AbortSignal) => Promise<boolean>;
};

export async function sessionContinuityFailure(
  protection: SessionProtection,
  authority: ConsumerAuthority,
  now: number,
  signal: AbortSignal,
  refresh: () => Promise<boolean>,
  revokePrincipal: (id: string) => void,
  options?: SessionContinuityOptions,
): Promise<string | null> {
  const checkUpstream = options?.upstreamSubjectActive ?? upstreamSubjectActive;
  if (protection.revocationUrl) {
    try {
      const active = await checkUpstream(protection.revocationUrl, protection.issuer, authority.principal.subject, signal);
      if (!active) {
        revokePrincipal(authority.principal.id);
        return "upstream_revoked";
      }
    } catch {
      return "upstream_unavailable";
    }
  }
  if (protection.kind !== "oidc") return null;
  const evidence = protection.evidenceAt;
  if (evidence !== null && now - evidence <= protection.freshnessMs) return null;
  return (await refresh()) ? null : "evidence_stale";
}
