import { admitEmbeddedConsumer } from "./handoff.js";
import { completeOidcSignIn, loopbackRequestUrl, prepareOidcConnection, refreshOidcEvidence, startOidcSignIn } from "./oidc.js";
import { ORDER_TOOL_ID, orderInput, orderOwnership, type OrderDataAdapter } from "./orders.js";
import {
  ConsumerIdentityStore,
  type ConsumerAssignmentView,
  type ConsumerAuditView,
  type ConsumerConnectionView,
  type HandoffConnection,
  type OidcConnection,
} from "./store.js";
import { sessionContinuityFailure } from "./sessionContinuity.js";
import { allowWithinScope, previewAuthority } from "./scope.js";
import {
  ConsumerAccessError,
  type AuthorizationEngine,
  type ConsumerAdmission,
  type ConsumerAuthority,
  type ConsumerPermission,
  type ConsumerRuntimeTool,
  type ConsumerScope,
  type OwnedResource,
} from "./types.js";

export class ConsumerAuthorization {
  constructor(private readonly store: ConsumerIdentityStore, private readonly engine: AuthorizationEngine,
    private readonly orders: OrderDataAdapter, readonly policyRevision: string, private readonly oidcAllowLoopback = false) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(policyRevision)) throw new ConsumerAccessError("identity.setup_required");
  }

  get workspaceId(): string {
    return this.store.workspaceId;
  }

  listConnections(): ConsumerConnectionView[] {
    return this.store.listConnections();
  }

  listAssignments(): ConsumerAssignmentView[] {
    return this.store.listAssignments();
  }

  listAudit(limit: number): ConsumerAuditView[] {
    return this.store.listAudit(limit);
  }

  registerHandoff(connection: HandoffConnection): void {
    this.store.registerHandoff(connection);
  }

  registerOidc(input: Omit<OidcConnection, "status" | "subjectClaim"> & { freshnessMs?: number }, clientSecret: string, allowLoopback = false): void {
    this.store.registerOidc(input, clientSecret, allowLoopback);
  }

  registerService(id: string, accountId: string, permission: ConsumerPermission): void {
    this.store.registerService(id, accountId, permission);
  }

  disableConnection(id: string): void {
    this.store.disableConnection(id);
  }

  prepareOidc(connectionId: string): Promise<void> {
    return prepareOidcConnection(this.store, connectionId, this.oidcAllowLoopback);
  }

  markOidcTested(id: string): void {
    this.store.markOidcTested(id);
  }

  oidcTested(id: string): boolean {
    return this.store.oidcTested(id);
  }

  activateOidc(id: string): void {
    this.store.activateOidc(id);
  }

  rotateOidcSecret(id: string, clientSecret: string): void {
    this.store.rotateOidcSecret(id, clientSecret);
  }

  setRevocationSource(connectionId: string, url: string | null): void {
    this.store.setRevocationSource(connectionId, url);
  }

  assign(connectionId: string, subject: string, accountId: string, mappingSource: string, permission: ConsumerPermission, expectedRevision?: number): string {
    return this.store.assign(connectionId, subject, accountId, mappingSource, permission, expectedRevision);
  }

  revokePrincipal(id: string): void {
    this.store.revoke("principal", id);
  }

  connectionView(id: string): ConsumerConnectionView | undefined {
    return this.store.listConnections().find((row) => row.id === id);
  }

  oidcSummary(id: string): Record<string, unknown> {
    const setup = this.store.oidcSetup(id);
    const listed = this.connectionView(id);
    const summary: Record<string, unknown> = {
      ...setup,
      ...(listed ? { callbackPath: listed.callbackPath, issuerChecks: listed.issuerChecks } : {}),
    };
    delete summary.clientSecret;
    delete summary.secret;
    return summary;
  }

  bind(conversation: string, sessionId: string, agentId: string, revision: number): void {
    this.store.bind(conversation, sessionId, agentId, revision);
  }

  conversation(conversation: string, sessionId: string, agentId: string, revision?: number): ConsumerAuthority {
    return this.store.conversation(conversation, sessionId, agentId, revision);
  }

  authenticate(token: string, agentId: string): ConsumerAuthority {
    return this.store.authenticate(token, agentId);
  }

  openServiceAuthority(agentId: string): ConsumerAuthority {
    return this.store.openServiceAuthority(agentId);
  }

  narrowAuthority(parent: ConsumerAuthority, childAgentId: string, narrowing: { actions?: string[]; resources?: string[] | null; expiresAt?: number }): ConsumerAuthority {
    return this.store.narrowAuthority(parent, childAgentId, narrowing);
  }

  onChange(listener: () => void): () => void {
    return this.store.onChange(listener);
  }

  async admit(connectionId: string, agentId: string, assertion: string): Promise<ConsumerAdmission> {
    const token = await admitEmbeddedConsumer(this.store, connectionId, agentId, assertion);
    const authority = this.store.authenticate(token, agentId);
    return { token, expiresAt: authority.expiresAt, sessionId: authority.sessionId };
  }

  startOidc(connectionId: string, agentId: string): Promise<{ authorizationUrl: string; state: string }> {
    return startOidcSignIn(this.store, connectionId, agentId, this.oidcAllowLoopback);
  }

  async completeOidc(agentId: string, currentUrl: URL): Promise<ConsumerAdmission> {
    const token = await completeOidcSignIn(this.store, agentId, currentUrl, this.oidcAllowLoopback);
    const authority = this.store.authenticate(token, agentId);
    return { token, expiresAt: authority.expiresAt, sessionId: authority.sessionId };
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
    return sessionContinuityFailure(
      protection,
      authority,
      this.store.currentTime(),
      signal,
      () => (protection.hasRefresh ? refreshOidcEvidence(this.store, authority.sessionId, this.oidcAllowLoopback) : Promise.resolve(false)),
      (id) => { this.store.revoke("principal", id); },
    );
  }
}
