import { assuranceMeets, requiredAssurance } from "./assurance.js";
import { admitChannelSender, ChannelSenderCache, type ChannelAdmission } from "./channel.js";
import { ConsumerStepUpRequired, issueStepUp, peekStepUpAccount, resolveStepUpOrigin, tryCompleteStepUp } from "./stepUp.js";
import { admitEmbeddedConsumer } from "./handoff.js";
import { completeOidcSignIn, loopbackRequestUrl, prepareOidcConnection, refreshOidcEvidence, startOidcSignIn } from "./oidc.js";
import { customerAdapterFromInput, orderInput, orderOwnership, type CustomerDataAdapter, type OrderDataAdapter } from "./customerApi.js";
import {
  ACCOUNT_PROFILE_TOOL_ID,
  DEFAULT_RESOURCE_TYPES,
  ORDER_LIST_TOOL_ID,
  ORDER_TOOL_ID,
  resolveResourceTool,
  type ResourceTypeDefinition,
} from "./resourceContract.js";
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
  private readonly senderCache = new ChannelSenderCache();
  private readonly customer: CustomerDataAdapter;
  resolveStepUpSlug?: (agentId: string) => string | undefined;

  constructor(private readonly store: ConsumerIdentityStore, private readonly engine: AuthorizationEngine,
    customer: CustomerDataAdapter | OrderDataAdapter, readonly policyRevision: string, private readonly oidcAllowLoopback = false,
    private readonly resourceTypes: readonly ResourceTypeDefinition[] = DEFAULT_RESOURCE_TYPES) {
    this.customer = customerAdapterFromInput(customer);
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

  registerChannel(input: { id: string; channelConnectionId: string; agentId: string; provider: "imessage" | "telegram" | "agentmail" | "email"; unmappedReply: string; permission: ConsumerPermission }): void {
    this.store.registerChannel(input);
  }

  hasChannelConnection(agentId: string, channelConnectionId: string): boolean {
    return (["imessage", "telegram", "agentmail", "email"] as const).some(
      (provider) => this.store.findChannelConnection(agentId, channelConnectionId, provider) !== undefined,
    );
  }

  bindingFor(conversation: string): { sessionId: string; agentId: string } | undefined {
    return this.store.bindingFor(conversation);
  }

  admitChannelSender(input: {
    agentId: string; channelConnectionId: string; provider: string; sender: string | undefined;
    conversationId?: string; dmarcPass?: boolean; signal: AbortSignal;
  }): Promise<ChannelAdmission> {
    return admitChannelSender(this.store, this.senderCache, this.customer, input);
  }

  completeStepUp(token: string, signedInAccountId: string): void {
    tryCompleteStepUp(this.store, token, signedInAccountId);
  }

  completeStepUpFromWebSession(token: string, webSessionId: string, agentId: string): void {
    const authority = this.store.resolve(webSessionId, agentId);
    tryCompleteStepUp(this.store, token, authority.principal.accountId);
  }

  peekStepUpAccount(token: string): string | undefined {
    return peekStepUpAccount(this.store, token);
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
    const binding = resolveResourceTool(this.resourceTypes, tool);
    if (!binding) throw new ConsumerAccessError("identity.not_available");
    const kind = binding.binding.kind;
    if (kind === "list") {
      await this.authorizeList(conversation, sessionId, agentId, tool, signal);
      return;
    }
    if (kind === "account_read") {
      await this.authorizeAccount(conversation, sessionId, agentId, tool, signal);
      return;
    }
    if (kind === "read") {
      await this.authorize(conversation, sessionId, agentId, tool, input, signal);
      return;
    }
    throw new ConsumerAccessError("identity.not_available");
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
      if (current.resource!.version !== disclosure.version) throw new ConsumerAccessError("identity.not_available");
    }
    this.store.conversation(conversation, sessionId, agentId, revision);
  }

  tools(conversation: string, sessionId: string, agentId: string): ConsumerRuntimeTool[] {
    const tools: ConsumerRuntimeTool[] = [];
    if (resolveResourceTool(this.resourceTypes, ORDER_TOOL_ID)) {
      tools.push({ name: "consumer_order_status", grantId: ORDER_TOOL_ID,
        description: "Read the status of an authorized order. Only an order identifier is accepted.",
        parameters: { type: "object", properties: { orderId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" } }, required: ["orderId"], additionalProperties: false },
        execute: async (input, signal) => {
          try {
            const before = await this.authorize(conversation, sessionId, agentId, ORDER_TOOL_ID, input, signal);
            const ordersType = this.resourceTypes.find((row) => row.id === "orders")!;
            const raw = await this.customer.read("orders", before.authority, before.resource!, "order:read", ordersType.readPath, signal);
            if (!("orderId" in raw)) throw new Error("invalid");
            const result = raw;
            const after = await this.authorize(conversation, sessionId, agentId, ORDER_TOOL_ID, input, signal);
            if (before.resource!.version !== after.resource!.version || before.resource!.ownerAccountId !== after.resource!.ownerAccountId
              || JSON.stringify(before.resource!.assignedAccountIds) !== JSON.stringify(after.resource!.assignedAccountIds)
              || before.authority.principal.revision !== after.authority.principal.revision) throw new Error("changed");
            if (result.orderId !== before.resource!.id || typeof result.status !== "string" || result.status.length > 200
              || typeof result.updatedAt !== "string" || !Number.isFinite(Date.parse(result.updatedAt))) throw new Error("invalid");
            this.store.recordDisclosure(sessionId, before.resource!.id, before.resource!.version);
            return JSON.stringify({ orderId: result.orderId, status: result.status, updatedAt: result.updatedAt });
          } catch (error) {
            if (error instanceof ConsumerAccessError && error.code === "identity.step_up_required") throw error;
            throw new ConsumerAccessError("identity.not_available");
          }
        } });
    }
    if (resolveResourceTool(this.resourceTypes, ORDER_LIST_TOOL_ID)) {
      const ordersType = this.resourceTypes.find((row) => row.id === "orders")!;
      tools.push({ name: "consumer_order_list", grantId: ORDER_LIST_TOOL_ID,
        description: "List orders for the signed-in customer account. Extra identifiers in the request are ignored.",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: async (input, signal) => {
          try {
            const ctx = await this.authorizeList(conversation, sessionId, agentId, ORDER_LIST_TOOL_ID, signal);
            const listed = await this.customer.list("orders", ctx.authority, ordersType.listPath!, signal);
            const visible: Array<{ id: string; version: string }> = [];
            for (const row of listed) {
              const resource = await this.customer.ownership(this.store.workspaceId, "orders", row.id, "orderId", signal);
              const allowed = await allowWithinScope(this.engine, {
                authority: ctx.authority, action: "order:read", resource, policyRevision: this.policyRevision,
              }, signal);
              if (!allowed) throw new Error("denied");
              visible.push({ id: row.id, version: row.version });
            }
            this.store.audit(ctx.authority.principal.id, conversation, "allow", "order_list");
            return JSON.stringify({ resources: visible });
          } catch (error) {
            if (error instanceof ConsumerAccessError && error.code === "identity.step_up_required") throw error;
            throw new ConsumerAccessError("identity.not_available");
          }
        } });
    }
    if (resolveResourceTool(this.resourceTypes, ACCOUNT_PROFILE_TOOL_ID)) {
      const accountType = this.resourceTypes.find((row) => row.id === "account")!;
      tools.push({ name: "consumer_account_profile", grantId: ACCOUNT_PROFILE_TOOL_ID,
        description: "Read the signed-in customer's account profile.",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: async (input, signal) => {
          try {
            const before = await this.authorizeAccount(conversation, sessionId, agentId, ACCOUNT_PROFILE_TOOL_ID, signal);
            const rawProfile = await this.customer.read("account", before.authority, before.resource!, "account:read", accountType.readPath, signal);
            if (!("displayName" in rawProfile)) throw new Error("invalid");
            const profile = rawProfile;
            const after = await this.authorizeAccount(conversation, sessionId, agentId, ACCOUNT_PROFILE_TOOL_ID, signal);
            if (before.authority.principal.revision !== after.authority.principal.revision
              || before.resource!.version !== after.resource!.version) throw new Error("changed");
            if (profile.accountId !== before.resource!.id || typeof profile.displayName !== "string") throw new Error("invalid");
            this.store.audit(before.authority.principal.id, conversation, "allow", "account_read");
            return JSON.stringify(profile);
          } catch (error) {
            if (error instanceof ConsumerAccessError && error.code === "identity.step_up_required") throw error;
            throw new ConsumerAccessError("identity.not_available");
          }
        } });
    }
    return tools;
  }

  private async authorize(conversation: string, sessionId: string, agentId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ authority: ConsumerAuthority; resource?: OwnedResource }> {
    let args: { orderId: string } | undefined;
    return this.runResourceGate(conversation, sessionId, agentId, tool, signal, "read", async ({ authority, binding }) => {
      if (authority.resources && args && !authority.resources.includes(args.orderId)) throw new Error("denied");
      const orderId = args!.orderId;
      const resource = orderOwnership.parse(await this.customer.ownership(this.store.workspaceId, "orders", orderId, "orderId", signal));
      if (resource.id !== orderId || resource.workspaceId !== this.store.workspaceId) throw new Error("denied");
      const allowed = await allowWithinScope(this.engine, { authority, action: binding.binding.permissionAction, resource, policyRevision: this.policyRevision }, signal);
      const current = this.store.conversation(conversation, sessionId, agentId);
      if (!allowed || signal.aborted || current.principal.revision !== authority.principal.revision) throw new Error("denied");
      this.store.audit(authority.principal.id, conversation, "allow", "order_read");
      return { authority, resource };
    }, () => { args = orderInput.parse(input); });
  }

  private async authorizeList(conversation: string, sessionId: string, agentId: string, tool: string, signal: AbortSignal): Promise<{ authority: ConsumerAuthority }> {
    return this.runResourceGate(conversation, sessionId, agentId, tool, signal, "list", async ({ authority }) => {
      const current = this.store.conversation(conversation, sessionId, agentId);
      if (signal.aborted || current.principal.revision !== authority.principal.revision) throw new Error("denied");
      return { authority };
    });
  }

  private async authorizeAccount(conversation: string, sessionId: string, agentId: string, tool: string, signal: AbortSignal): Promise<{ authority: ConsumerAuthority; resource: OwnedResource }> {
    return this.runResourceGate(conversation, sessionId, agentId, tool, signal, "account_read", async ({ authority, binding }) => {
      const accountId = authority.principal.accountId;
      const resource = orderOwnership.parse(await this.customer.ownership(this.store.workspaceId, "account", accountId, "accountId", signal));
      if (resource.id !== accountId || resource.workspaceId !== this.store.workspaceId || resource.ownerAccountId !== accountId) throw new Error("denied");
      const allowed = await allowWithinScope(this.engine, { authority, action: binding.binding.permissionAction, resource, policyRevision: this.policyRevision }, signal);
      const current = this.store.conversation(conversation, sessionId, agentId);
      if (!allowed || signal.aborted || current.principal.revision !== authority.principal.revision) throw new Error("denied");
      return { authority, resource };
    });
  }

  private async runResourceGate<T>(
    conversation: string,
    sessionId: string,
    agentId: string,
    tool: string,
    signal: AbortSignal,
    kind: "read" | "list" | "account_read",
    finish: (gate: { authority: ConsumerAuthority; binding: NonNullable<ReturnType<typeof resolveResourceTool>> }) => Promise<T>,
    prepare?: () => void,
  ): Promise<T> {
    let authority: ConsumerAuthority | undefined;
    let denyReason = "order_not_available";
    try {
      prepare?.();
      authority = this.store.conversation(conversation, sessionId, agentId);
      const protection = await this.protectionFailure(authority, signal);
      if (protection) {
        denyReason = protection;
        throw new Error("denied");
      }
      const required = requiredAssurance(tool);
      const currentAssurance = this.store.sessionAssurance(authority.sessionId);
      if (!assuranceMeets(currentAssurance, required)) {
        denyReason = "assurance_insufficient";
        if (this.store.sessionProtection(authority.sessionId).kind === "channel") this.raiseStepUp(authority, conversation);
        throw new Error("denied");
      }
      const binding = resolveResourceTool(this.resourceTypes, tool);
      const permission = authority.principal.permission;
      if (signal.aborted || !binding || binding.binding.kind !== kind
        || !authority.actions.includes(binding.binding.permissionAction)
        || !permission.actions.includes(binding.binding.permissionAction)) throw new Error("denied");
      return await finish({ authority, binding });
    } catch (error) {
      if (error instanceof ConsumerAccessError && error.code === "identity.step_up_required") throw error;
      this.store.audit(authority?.principal.id ?? null, conversation, "deny", denyReason);
      throw new ConsumerAccessError("identity.not_available");
    }
  }

  private raiseStepUp(authority: ConsumerAuthority, conversation: string): never {
    const origin = resolveStepUpOrigin();
    if (!origin) {
      this.store.audit(authority.principal.id, conversation, "deny", "step_up_origin_missing");
      throw new ConsumerAccessError("identity.step_up_required");
    }
    const slug = this.resolveStepUpSlug?.(authority.agentId) ?? authority.agentId;
    const issued = issueStepUp(this.store, {
      channelSessionId: authority.sessionId,
      agentId: authority.agentId,
      accountId: authority.principal.accountId,
      principalId: authority.principal.id,
      slug,
    }, origin);
    this.store.audit(authority.principal.id, conversation, "deny", "assurance_insufficient");
    throw new ConsumerStepUpRequired(issued.reply);
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
