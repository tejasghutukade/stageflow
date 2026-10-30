import { admitEmbeddedConsumer } from "./handoff.js";
import { boundedGet } from "./http.js";
import { completeOidcSignIn, loopbackRequestUrl, refreshOidcEvidence, startOidcSignIn } from "./oidc.js";
import { ORDER_TOOL_ID, orderInput, orderOwnership, type OrderDataAdapter } from "./orders.js";
import { ConsumerIdentityStore } from "./store.js";
import { allowWithinScope, previewAuthority } from "./scope.js";
import { ConsumerAccessError, type AuthorizationEngine, type ConsumerAuthority, type ConsumerRuntimeTool, type ConsumerScope, type OwnedResource } from "./types.js";

export class ConsumerAuthorization {
  constructor(readonly store: ConsumerIdentityStore, private readonly engine: AuthorizationEngine,
    private readonly orders: OrderDataAdapter, readonly policyRevision: string, private readonly oidcAllowLoopback = false) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(policyRevision)) throw new ConsumerAccessError("identity.setup_required");
  }

  admit(connectionId: string, agentId: string, assertion: string): Promise<string> {
    return admitEmbeddedConsumer(this.store, connectionId, agentId, assertion);
  }

  startOidc(connectionId: string, agentId: string): Promise<{ authorizationUrl: string; state: string }> {
    return startOidcSignIn(this.store, connectionId, agentId, this.oidcAllowLoopback);
  }

  completeOidc(agentId: string, currentUrl: URL): Promise<string> {
    return completeOidcSignIn(this.store, agentId, currentUrl, this.oidcAllowLoopback);
  }

  requestUrl(hostHeader: string | undefined, rawUrl: string): URL {
    return loopbackRequestUrl(hostHeader, rawUrl, this.oidcAllowLoopback);
  }

  async check(conversation: string, sessionId: string, agentId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    await this.authorize(conversation, sessionId, agentId, tool, input, signal);
  }

  async preview(accountId: string, scope: ConsumerScope, resources: string[] | null, order: OwnedResource, signal: AbortSignal): Promise<boolean> {
    try {
      return await allowWithinScope(this.engine, {
        authority: previewAuthority(this.store.workspaceId, accountId, scope, resources, this.store.currentTime()),
        action: "order:read", resource: order, policyRevision: this.policyRevision,
      }, signal);
    } catch {
      return false;
    }
  }

  async validateConversation(conversation: string, sessionId: string, agentId: string, revision?: number): Promise<void> {
    this.store.conversation(conversation, sessionId, agentId, revision);
    for (const disclosure of this.store.disclosures(sessionId)) {
      const current = await this.authorize(conversation, sessionId, agentId, ORDER_TOOL_ID, { orderId: disclosure.resource }, AbortSignal.timeout(3_000));
      if (current.resource.version !== disclosure.version) throw new ConsumerAccessError("identity.not_available");
    }
    this.store.conversation(conversation, sessionId, agentId, revision);
  }

  tools(conversation: string, sessionId: string, agentId: string): ConsumerRuntimeTool[] {
    return [{ name: "consumer_order_status", grantId: ORDER_TOOL_ID,
      description: "Read the status of an authorized order. Only an order identifier is accepted.",
      parameters: { type: "object", properties: { orderId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" } }, required: ["orderId"], additionalProperties: false },
      execute: async (input, signal) => {
        try {
          const before = await this.authorize(conversation, sessionId, agentId, ORDER_TOOL_ID, input, signal);
          const result = await this.orders.read(before.authority, before.resource, signal);
          const after = await this.authorize(conversation, sessionId, agentId, ORDER_TOOL_ID, input, signal);
          if (before.authority.principal.revision !== after.authority.principal.revision
            || before.resource.version !== after.resource.version || before.resource.ownerAccountId !== after.resource.ownerAccountId
            || JSON.stringify(before.resource.assignedAccountIds) !== JSON.stringify(after.resource.assignedAccountIds)) throw new Error("changed");
          if (result.orderId !== before.resource.id || typeof result.status !== "string" || result.status.length > 200
            || typeof result.updatedAt !== "string" || !Number.isFinite(Date.parse(result.updatedAt))) throw new Error("invalid");
          this.store.recordDisclosure(sessionId, before.resource.id, before.resource.version);
          return JSON.stringify({ orderId: result.orderId, status: result.status, updatedAt: result.updatedAt });
        } catch { throw new ConsumerAccessError("identity.not_available"); }
      } }];
  }

  private async authorize(conversation: string, sessionId: string, agentId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ authority: ConsumerAuthority; resource: OwnedResource }> {
    let authority: ConsumerAuthority | undefined;
    let denyReason = "order_not_available";
    try {
      const args = orderInput.parse(input);
      authority = this.store.conversation(conversation, sessionId, agentId);
      const protection = await this.protectionFailure(authority, signal);
      if (protection) {
        denyReason = protection;
        throw new Error("denied");
      }
      const permission = authority.principal.permission;
      if (signal.aborted || tool !== ORDER_TOOL_ID || !authority.actions.includes("order:read") || !permission.actions.includes("order:read")
        || (authority.resources && !authority.resources.includes(args.orderId))) throw new Error("denied");
      const resource = orderOwnership.parse(await this.orders.ownership(this.store.workspaceId, args.orderId, signal));
      if (resource.id !== args.orderId || resource.workspaceId !== this.store.workspaceId) throw new Error("denied");
      const allowed = await allowWithinScope(this.engine, { authority, action: "order:read", resource, policyRevision: this.policyRevision }, signal);
      const current = this.store.conversation(conversation, sessionId, agentId);
      if (!allowed || signal.aborted || current.principal.revision !== authority.principal.revision) throw new Error("denied");
      this.store.audit(authority.principal.id, conversation, "allow", "order_read");
      return { authority, resource };
    } catch {
      this.store.audit(authority?.principal.id ?? null, conversation, "deny", denyReason);
      throw new ConsumerAccessError("identity.not_available");
    }
  }

  private async protectionFailure(authority: ConsumerAuthority, signal: AbortSignal): Promise<string | null> {
    const protection = this.store.sessionProtection(authority.sessionId);
    if (protection.revocationUrl) {
      try {
        const active = await this.upstreamActive(protection.revocationUrl, protection.issuer, authority.principal.subject, signal);
        if (!active) {
          this.store.revoke("principal", authority.principal.id);
          return "upstream_revoked";
        }
      } catch {
        return "upstream_unavailable";
      }
    }
    if (protection.kind !== "oidc") return null;
    const evidence = protection.evidenceAt;
    if (evidence !== null && this.store.currentTime() - evidence <= protection.freshnessMs) return null;
    const refreshed = protection.hasRefresh ? await refreshOidcEvidence(this.store, authority.sessionId, this.oidcAllowLoopback) : false;
    return refreshed ? null : "evidence_stale";
  }

  private async upstreamActive(url: string, issuer: string | null, subject: string, signal: AbortSignal): Promise<boolean> {
    if (!issuer) throw new Error("request_failed");
    const endpoint = new URL(url);
    const issuerUrl = new URL(issuer);
    if (endpoint.origin !== issuerUrl.origin || endpoint.username || endpoint.password) throw new Error("request_failed");
    endpoint.searchParams.set("subject", subject);
    const body = await boundedGet(endpoint, signal);
    if (typeof body !== "object" || body === null || typeof (body as { active?: unknown }).active !== "boolean") throw new Error("request_failed");
    return (body as { active: boolean }).active;
  }
}
