import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { isLoopbackHostname, trustedIssuer } from "./http.js";
import { ConsumerAccessError, type ConsumerAuthority, type ConsumerPermission, type ConsumerPrincipal, type ConsumerScope } from "./types.js";

const OIDC_ISSUER_CHECKS = [
  "HTTPS issuer",
  "Discovery, keys, and token URLs stay on the issuer origin",
  "ID token signature is verified",
  "Subject claim must be sub",
  "Callback must be this Host's /api/public/chat/:slug/oidc/callback",
] as const;
const LOCAL_REVOCATION_NOTE = "Local revoke is immediate. Upstream removal is not detected.";
const CONNECTED_REVOCATION_NOTE = "Upstream removal blocks the next protected action.";
export const DEFAULT_OIDC_FRESHNESS_MS = 300_000;
const SERVICE_SESSION_MS = 5 * 60 * 1000;

const permissionSchema = z.strictObject({
  scope: z.enum(["own", "assigned", "selected", "workspace"]),
  agents: z.array(z.string().min(1)).min(1),
  actions: z.array(z.enum(["order:read", "conversation:use"])).min(1),
  resources: z.array(z.string().min(1)).optional(),
});

export type HandoffConnection = {
  id: string;
  issuer: string;
  agentId: string;
  audience: string;
  publicJwks: { keys: Record<string, unknown>[] };
  algorithms: Array<"RS256" | "ES256" | "EdDSA">;
};

export type OidcSigningAlgorithm = "RS256" | "ES256" | "EdDSA";

export type OidcConnection = {
  id: string;
  issuer: string;
  clientId: string;
  agentId: string;
  redirectUri: string;
  algorithms: OidcSigningAlgorithm[];
  subjectClaim: "sub";
  status: "draft" | "validated" | "active" | "disabled";
};

type OidcStored = OidcConnection & {
  kind: "oidc";
  tested?: boolean;
  freshnessMs?: number;
  revocationUrl?: string | null;
};

export type ConsumerConnectionView = {
  id: string;
  kind: "handoff" | "oidc" | "service";
  active: boolean;
  status: "draft" | "validated" | "active" | "disabled";
  callbackPath: string | null;
  issuer: string | null;
  issuerChecks: string[];
  upstreamRevocation: "connected" | "local_only";
  upstreamNote: string;
};

export type ConsumerAssignmentView = {
  id: string;
  connectionId: string;
  subject: string;
  accountId: string;
  scope: ConsumerScope;
  resources: string[] | null;
  revision: number;
  active: boolean;
};

export type ConsumerAuditView = {
  at: number;
  principalId: string | null;
  conversationId: string | null;
  outcome: "allow" | "deny";
  reason: string;
};

export type SessionProtection = {
  kind: "handoff" | "oidc" | "service";
  connectionId: string;
  issuer: string | null;
  evidenceAt: number | null;
  freshnessMs: number;
  revocationUrl: string | null;
  hasRefresh: boolean;
};

export class ConsumerIdentityStore {
  private readonly db: Database.Database;
  private readonly listeners = new Set<() => void>();

  constructor(filename: string, readonly workspaceId: string, private readonly now: () => number = Date.now) {
    if (!workspaceId.trim()) throw new Error("An explicit Workspace is required");
    this.db = new Database(filename);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) {
      this.db.close();
      throw new Error("Consumer identity schema is newer than this runtime");
    }
    const initialize = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS identity_workspace (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS identity_connections (
          workspace TEXT NOT NULL, id TEXT NOT NULL, config TEXT NOT NULL, secret TEXT, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(workspace, id), FOREIGN KEY(workspace) REFERENCES identity_workspace(id));
        CREATE TABLE IF NOT EXISTS identity_principals (
          workspace TEXT NOT NULL, id TEXT NOT NULL, connection TEXT NOT NULL, subject TEXT NOT NULL,
          account TEXT NOT NULL, mapping_source TEXT NOT NULL, permission TEXT NOT NULL,
          revision INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(workspace, id), UNIQUE(workspace, connection, subject),
          FOREIGN KEY(workspace, connection) REFERENCES identity_connections(workspace, id));
        CREATE TABLE IF NOT EXISTS identity_sessions (
          workspace TEXT NOT NULL, id TEXT NOT NULL, principal TEXT NOT NULL, agent TEXT NOT NULL,
          expires INTEGER NOT NULL, principal_revision INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(workspace, id), FOREIGN KEY(workspace, principal) REFERENCES identity_principals(workspace, id));
        CREATE TABLE IF NOT EXISTS identity_grants (
          workspace TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL, actions TEXT NOT NULL,
          resources TEXT, expires INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(workspace, id), UNIQUE(workspace, session),
          FOREIGN KEY(workspace, session) REFERENCES identity_sessions(workspace, id));
        CREATE TABLE IF NOT EXISTS identity_replays (
          workspace TEXT NOT NULL, connection TEXT NOT NULL, assertion TEXT NOT NULL, expires INTEGER NOT NULL,
          PRIMARY KEY(workspace, connection, assertion),
          FOREIGN KEY(workspace, connection) REFERENCES identity_connections(workspace, id));
        CREATE TABLE IF NOT EXISTS identity_bindings (
          workspace TEXT NOT NULL, conversation TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL,
          revision INTEGER NOT NULL, PRIMARY KEY(workspace, conversation),
          FOREIGN KEY(workspace, session) REFERENCES identity_sessions(workspace, id));
        CREATE TABLE IF NOT EXISTS identity_audit (
          id TEXT PRIMARY KEY, workspace TEXT NOT NULL, principal TEXT, conversation TEXT,
          outcome TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
          FOREIGN KEY(workspace) REFERENCES identity_workspace(id));
        CREATE TABLE IF NOT EXISTS identity_disclosures (
          workspace TEXT NOT NULL, session TEXT NOT NULL, resource TEXT NOT NULL, version TEXT NOT NULL,
          PRIMARY KEY(workspace, session, resource),
          FOREIGN KEY(workspace, session) REFERENCES identity_sessions(workspace, id));
        CREATE TABLE IF NOT EXISTS identity_oidc_transactions (
          workspace TEXT NOT NULL, state TEXT NOT NULL, connection TEXT NOT NULL, agent TEXT NOT NULL,
          verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect TEXT NOT NULL, expires INTEGER NOT NULL,
          PRIMARY KEY(workspace, state),
          FOREIGN KEY(workspace, connection) REFERENCES identity_connections(workspace, id));
      `);
      const columns = this.db.prepare("PRAGMA table_info(identity_connections)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "secret")) this.db.exec("ALTER TABLE identity_connections ADD COLUMN secret TEXT");
      const sessionColumns = this.db.prepare("PRAGMA table_info(identity_sessions)").all() as Array<{ name: string }>;
      if (!sessionColumns.some((column) => column.name === "parent_session")) this.db.exec("ALTER TABLE identity_sessions ADD COLUMN parent_session TEXT");
      if (!sessionColumns.some((column) => column.name === "evidence_at")) this.db.exec("ALTER TABLE identity_sessions ADD COLUMN evidence_at INTEGER");
      if (!sessionColumns.some((column) => column.name === "refresh_secret")) this.db.exec("ALTER TABLE identity_sessions ADD COLUMN refresh_secret TEXT");
      const existing = this.db.prepare("SELECT id FROM identity_workspace").get() as { id: string } | undefined;
      if (existing && existing.id !== workspaceId) throw new Error("Identity database belongs to another Workspace");
      this.db.prepare("INSERT OR IGNORE INTO identity_workspace(id) VALUES (?)").run(workspaceId);
      this.db.pragma("user_version = 1");
    });
    try {
      initialize();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  registerHandoff(connection: HandoffConnection): void {
    if (!connection.id || !connection.issuer || !connection.agentId || !connection.audience || !connection.algorithms.length
      || connection.algorithms.some((algorithm) => !["RS256", "ES256", "EdDSA"].includes(algorithm))
      || !connection.publicJwks.keys.length || connection.publicJwks.keys.some((key) => key.d !== undefined || key.k !== undefined)) {
      throw new ConsumerAccessError("identity.setup_required");
    }
    this.db.prepare("INSERT INTO identity_connections(workspace, id, config) VALUES (?, ?, ?)")
      .run(this.workspaceId, connection.id, JSON.stringify(connection));
    this.audit(null, null, "allow", "connection_registered");
  }

  connection(id: string): HandoffConnection {
    const config = this.connectionConfig(id, true);
    if (config.kind === "oidc" || config.kind === "service") throw new ConsumerAccessError("identity.verification_required");
    return config as HandoffConnection;
  }

  registerOidc(input: Omit<OidcConnection, "status" | "subjectClaim"> & { freshnessMs?: number }, clientSecret: string, allowLoopback = false): void {
    const id = this.connectionId(input.id);
    let issuer: URL;
    let redirect: URL;
    try {
      issuer = trustedIssuer(input.issuer, allowLoopback);
      redirect = new URL(input.redirectUri);
    } catch {
      throw new ConsumerAccessError("identity.setup_required");
    }
    if (redirect.username || redirect.password || redirect.search || redirect.hash
      || !redirect.pathname.endsWith("/oidc/callback")
      || (redirect.protocol !== "https:" && !(allowLoopback && redirect.protocol === "http:" && isLoopbackHostname(redirect.hostname)))
      || !/^[A-Za-z0-9._-]{1,128}$/.test(input.clientId) || !input.agentId
      || !input.algorithms.length || input.algorithms.some((algorithm) => !["RS256", "ES256", "EdDSA"].includes(algorithm))
      || clientSecret.length < 16 || clientSecret.length > 512 || /[\r\n]/.test(clientSecret)
      || (input.freshnessMs !== undefined && !validFreshness(input.freshnessMs))) {
      throw new ConsumerAccessError("identity.setup_required");
    }
    const config: OidcStored = {
      kind: "oidc", id, issuer: issuer.origin, clientId: input.clientId, agentId: input.agentId,
      redirectUri: redirect.origin + redirect.pathname, algorithms: input.algorithms, subjectClaim: "sub", status: "draft",
      ...(input.freshnessMs !== undefined ? { freshnessMs: input.freshnessMs } : {}),
    };
    this.db.prepare("INSERT INTO identity_connections(workspace, id, config, secret, active) VALUES (?, ?, ?, ?, 0)")
      .run(this.workspaceId, id, JSON.stringify(config), clientSecret);
    this.audit(null, null, "allow", "oidc_registered");
  }

  oidcConnection(id: string): OidcConnection {
    const row = this.db.prepare("SELECT active FROM identity_connections WHERE workspace = ? AND id = ?")
      .get(this.workspaceId, id) as { active: number } | undefined;
    const config = this.readStoredOidc(id);
    if (!row || row.active !== 1 || config.status !== "active") throw new ConsumerAccessError("identity.setup_required");
    return this.publicOidc(config);
  }

  oidcSetup(id: string): OidcConnection {
    return this.publicOidc(this.readStoredOidc(id));
  }

  oidcClientSecret(id: string): string {
    const row = this.db.prepare("SELECT secret FROM identity_connections WHERE workspace = ? AND id = ?")
      .get(this.workspaceId, id) as { secret: string | null } | undefined;
    if (!row?.secret) throw new ConsumerAccessError("identity.setup_required");
    return row.secret;
  }

  markOidcValidated(id: string): void {
    const config = this.readStoredOidc(id);
    if (config.status !== "draft" && config.status !== "validated") throw new ConsumerAccessError("identity.setup_required");
    this.writeOidc({ ...config, status: "validated" }, 0);
  }

  activateOidc(id: string): void {
    const config = this.readStoredOidc(id);
    if (config.status !== "validated") throw new ConsumerAccessError("identity.setup_required");
    this.writeOidc({ ...config, status: "active" }, 1);
    this.audit(null, null, "allow", "oidc_activated");
  }

  beginOidc(state: string, connectionId: string, agentId: string, verifier: string, nonce: string, redirect: string, expiresAt: number): void {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(state) || !/^[A-Za-z0-9_-]{16,256}$/.test(verifier) || !/^[A-Za-z0-9_-]{16,256}$/.test(nonce)) {
      throw new ConsumerAccessError("identity.verification_required");
    }
    this.oidcConnection(connectionId);
    this.db.prepare("DELETE FROM identity_oidc_transactions WHERE workspace = ? AND expires <= ?").run(this.workspaceId, this.now());
    this.db.prepare("INSERT INTO identity_oidc_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, state, connectionId, agentId, verifier, nonce, redirect, expiresAt);
  }

  consumeOidc(state: string): { connectionId: string; agentId: string; verifier: string; nonce: string; redirect: string } {
    const row = this.db.prepare(`DELETE FROM identity_oidc_transactions WHERE workspace = ? AND state = ? AND expires > ?
      RETURNING connection, agent, verifier, nonce, redirect`)
      .get(this.workspaceId, state, this.now()) as { connection: string; agent: string; verifier: string; nonce: string; redirect: string } | undefined;
    if (!row) throw new ConsumerAccessError("identity.verification_required");
    return { connectionId: row.connection, agentId: row.agent, verifier: row.verifier, nonce: row.nonce, redirect: row.redirect };
  }

  assign(connectionId: string, subject: string, accountId: string, mappingSource: string, permission: ConsumerPermission, expectedRevision?: number): string {
    this.connectionConfig(connectionId, false);
    const parsed = permissionSchema.parse(permission);
    if (!subject || !accountId || !mappingSource || (parsed.scope === "selected" && !parsed.resources?.length)) {
      throw new ConsumerAccessError("identity.setup_required");
    }
    const id = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id, revision FROM identity_principals WHERE workspace = ? AND connection = ? AND subject = ?")
        .get(this.workspaceId, connectionId, subject) as { id: string; revision: number } | undefined;
      if (expectedRevision !== undefined && (existing?.revision ?? 0) !== expectedRevision) throw new ConsumerAccessError("identity.conflict");
      const principalId = existing?.id ?? randomUUID();
      this.db.prepare(`INSERT INTO identity_principals(workspace, id, connection, subject, account, mapping_source, permission, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(workspace, connection, subject) DO UPDATE SET
        account = excluded.account, mapping_source = excluded.mapping_source, permission = excluded.permission, revision = revision + 1`)
        .run(this.workspaceId, principalId, connectionId, subject, accountId, mappingSource, JSON.stringify(parsed));
      this.audit(principalId, null, "allow", "permission_assigned");
      return principalId;
    })();
    this.changed();
    return id;
  }

  admit(connection: HandoffConnection, subject: string, assertionId: string, expiresAt: number): string {
    return this.db.transaction(() => {
      const current = this.connection(connection.id);
      if (JSON.stringify(current) !== JSON.stringify(connection)) throw new ConsumerAccessError("identity.verification_required");
      return this.establishSession(connection.id, connection.agentId, subject, assertionId, expiresAt);
    })();
  }

  establishSession(connectionId: string, agentId: string, subject: string, assertionId: string, expiresAt: number): string {
    return this.db.transaction(() => {
      const connection = this.db.prepare("SELECT active FROM identity_connections WHERE workspace = ? AND id = ?")
        .get(this.workspaceId, connectionId) as { active: number } | undefined;
      if (!connection || connection.active !== 1) throw new ConsumerAccessError("identity.verification_required");
      const principal = this.db.prepare("SELECT id, permission, revision FROM identity_principals WHERE workspace = ? AND connection = ? AND subject = ? AND active = 1")
        .get(this.workspaceId, connectionId, subject) as { id: string; permission: string; revision: number } | undefined;
      if (!principal || expiresAt <= this.now()) throw new ConsumerAccessError("identity.verification_required");
      const permission = permissionSchema.parse(JSON.parse(principal.permission));
      if (!permission.agents.includes(agentId) || !permission.actions.includes("conversation:use")) throw new ConsumerAccessError("identity.not_available");
      this.db.prepare("DELETE FROM identity_replays WHERE workspace = ? AND expires <= ?").run(this.workspaceId, this.now());
      this.db.prepare("INSERT INTO identity_replays VALUES (?, ?, ?, ?)").run(this.workspaceId, connectionId, assertionId, expiresAt);
      const token = randomBytes(32).toString("base64url");
      const id = this.digest(token);
      this.db.prepare("INSERT INTO identity_sessions(workspace, id, principal, agent, expires, principal_revision, evidence_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, id, principal.id, agentId, expiresAt, principal.revision, this.now());
      this.db.prepare("INSERT INTO identity_grants(workspace, id, session, actions, resources, expires) VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, randomUUID(), id, JSON.stringify(permission.actions), permission.resources ? JSON.stringify(permission.resources) : null, expiresAt);
      this.audit(principal.id, null, "allow", "admitted");
      return token;
    })();
  }

  authenticate(token: string, agentId: string): ConsumerAuthority {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ConsumerAccessError("identity.verification_required");
    const authority = this.resolve(this.digest(token), agentId);
    if (authority.principal.subject.startsWith("service:")) throw new ConsumerAccessError("identity.verification_required");
    return authority;
  }

  resolve(sessionId: string, agentId: string): ConsumerAuthority {
    const row = this.db.prepare(`SELECT p.*, s.id AS session_id, s.expires AS session_expires, g.id AS grant_id,
      g.actions, g.resources, g.expires AS grant_expires FROM identity_sessions s
      JOIN identity_principals p ON p.workspace = s.workspace AND p.id = s.principal
      JOIN identity_connections c ON c.workspace = p.workspace AND c.id = p.connection
      JOIN identity_grants g ON g.workspace = s.workspace AND g.session = s.id
      WHERE s.workspace = ? AND s.id = ? AND s.agent = ? AND s.active = 1 AND p.active = 1 AND c.active = 1
      AND g.active = 1 AND s.principal_revision = p.revision AND s.expires > ? AND g.expires > ?`)
      .get(this.workspaceId, sessionId, agentId, this.now(), this.now()) as Record<string, string | number | null> | undefined;
    if (!row) throw new ConsumerAccessError("identity.verification_required");
    const permission = permissionSchema.parse(JSON.parse(row.permission as string));
    if (!permission.agents.includes(agentId) || !permission.actions.includes("conversation:use")) throw new ConsumerAccessError("identity.not_available");
    const principal: ConsumerPrincipal = {
      id: row.id as string, workspaceId: this.workspaceId, connectionId: row.connection as string,
      subject: row.subject as string, accountId: row.account as string, mappingSource: row.mapping_source as string,
      revision: row.revision as number, permission,
    };
    return { principal, sessionId, grantId: row.grant_id as string, agentId,
      expiresAt: Math.min(row.session_expires as number, row.grant_expires as number),
      actions: JSON.parse(row.actions as string), resources: row.resources ? JSON.parse(row.resources as string) : null };
  }

  bind(conversation: string, sessionId: string, agentId: string, revision: number): void {
    this.resolve(sessionId, agentId);
    this.db.prepare("INSERT INTO identity_bindings VALUES (?, ?, ?, ?, ?)").run(this.workspaceId, conversation, sessionId, agentId, revision);
  }

  conversation(conversation: string, sessionId: string, agentId: string, revision?: number): ConsumerAuthority {
    const row = this.db.prepare("SELECT revision FROM identity_bindings WHERE workspace = ? AND conversation = ? AND session = ? AND agent = ?")
      .get(this.workspaceId, conversation, sessionId, agentId) as { revision: number } | undefined;
    if (!row || (revision !== undefined && row.revision !== revision)) throw new ConsumerAccessError("identity.not_available");
    return this.resolve(sessionId, agentId);
  }

  revoke(kind: "session" | "principal" | "connection" | "grant", id: string): void {
    const tables = { session: "identity_sessions", principal: "identity_principals", connection: "identity_connections", grant: "identity_grants" };
    this.db.transaction(() => {
      this.db.prepare(`UPDATE ${tables[kind]} SET active = 0 WHERE workspace = ? AND id = ?`).run(this.workspaceId, id);
      if (kind === "session") this.deactivateDescendants(id);
      if (kind === "grant") {
        const grant = this.db.prepare("SELECT session FROM identity_grants WHERE workspace = ? AND id = ?")
          .get(this.workspaceId, id) as { session: string } | undefined;
        if (grant) this.deactivateDescendants(grant.session);
      }
      this.audit(null, null, "allow", `${kind}_revoked`);
    })();
    this.changed();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  recordDisclosure(sessionId: string, resource: string, version: string): void {
    this.db.prepare(`INSERT INTO identity_disclosures VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace, session, resource) DO UPDATE SET version = excluded.version`)
      .run(this.workspaceId, sessionId, resource, version);
  }

  disclosures(sessionId: string): Array<{ resource: string; version: string }> {
    return this.db.prepare("SELECT resource, version FROM identity_disclosures WHERE workspace = ? AND session = ?")
      .all(this.workspaceId, sessionId) as Array<{ resource: string; version: string }>;
  }

  audit(principal: string | null, conversation: string | null, outcome: "allow" | "deny", reason: string): void {
    this.db.prepare("INSERT INTO identity_audit VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), this.workspaceId, principal, conversation, outcome, reason, this.now());
  }

  currentTime(): number { return this.now(); }

  listConnections(): ConsumerConnectionView[] {
    const rows = this.db.prepare("SELECT id, config, active FROM identity_connections WHERE workspace = ? ORDER BY id")
      .all(this.workspaceId) as Array<{ id: string; config: string; active: number }>;
    return rows.map((row) => this.connectionView(row));
  }

  listAssignments(): ConsumerAssignmentView[] {
    const rows = this.db.prepare("SELECT id, connection, subject, account, permission, revision, active FROM identity_principals WHERE workspace = ? ORDER BY subject")
      .all(this.workspaceId) as Array<{ id: string; connection: string; subject: string; account: string; permission: string; revision: number; active: number }>;
    return rows.map((row) => {
      const permission = permissionSchema.parse(JSON.parse(row.permission));
      return { id: row.id, connectionId: row.connection, subject: row.subject, accountId: row.account, scope: permission.scope,
        resources: permission.resources ?? null, revision: row.revision, active: row.active === 1 };
    });
  }

  listAudit(limit: number): ConsumerAuditView[] {
    const capped = Number.isFinite(limit) ? Math.min(Math.max(0, Math.floor(limit)), 200) : 0;
    if (capped === 0) return [];
    const rows = this.db.prepare("SELECT principal, conversation, outcome, reason, at FROM identity_audit WHERE workspace = ? ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(this.workspaceId, capped) as Array<{ principal: string | null; conversation: string | null; outcome: string; reason: string; at: number }>;
    return rows.map((row) => ({ at: row.at, principalId: row.principal, conversationId: row.conversation,
      outcome: row.outcome === "allow" ? "allow" : "deny", reason: row.reason }));
  }

  disableConnection(id: string): void {
    const row = this.connectionRow(id);
    const config = JSON.parse(row.config) as Record<string, unknown>;
    if (config.kind === "oidc" || config.kind === "service") {
      this.db.prepare("UPDATE identity_connections SET active = 0, config = ? WHERE workspace = ? AND id = ?")
        .run(JSON.stringify({ ...config, status: "disabled" }), this.workspaceId, id);
    } else {
      this.db.prepare("UPDATE identity_connections SET active = 0 WHERE workspace = ? AND id = ?").run(this.workspaceId, id);
    }
    this.audit(null, null, "allow", "connection_disabled");
  }

  rotateOidcSecret(id: string, clientSecret: string): void {
    this.readStoredOidc(id);
    if (!validClientSecret(clientSecret)) throw new ConsumerAccessError("identity.setup_required");
    this.db.prepare("UPDATE identity_connections SET secret = ? WHERE workspace = ? AND id = ?").run(clientSecret, this.workspaceId, id);
  }

  markOidcTested(id: string): void {
    const row = this.connectionRow(id);
    const config = this.readStoredOidc(id);
    this.writeOidc({ ...config, tested: true }, row.active === 1 ? 1 : 0);
  }

  oidcTested(id: string): boolean {
    return this.readStoredOidc(id).tested === true;
  }

  setFreshnessMs(id: string, freshnessMs: number): void {
    const row = this.connectionRow(id);
    const config = this.readStoredOidc(id);
    if (!validFreshness(freshnessMs)) throw new ConsumerAccessError("identity.setup_required");
    this.writeOidc({ ...config, freshnessMs }, row.active === 1 ? 1 : 0);
  }

  setRevocationSource(connectionId: string, url: string | null): void {
    const row = this.connectionRow(connectionId);
    const config = this.readStoredOidc(connectionId);
    if (url === null) {
      const { revocationUrl: _removed, ...rest } = config;
      this.writeOidc(rest, row.active === 1 ? 1 : 0);
      return;
    }
    let parsed: URL;
    let issuer: URL;
    try {
      parsed = new URL(url);
      issuer = new URL(config.issuer);
    } catch {
      throw new ConsumerAccessError("identity.setup_required");
    }
    const loopback = issuer.protocol === "http:" && isLoopbackHostname(issuer.hostname);
    if (parsed.origin !== issuer.origin || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)))) {
      throw new ConsumerAccessError("identity.setup_required");
    }
    this.writeOidc({ ...config, revocationUrl: parsed.origin + parsed.pathname }, row.active === 1 ? 1 : 0);
  }

  registerService(id: string, accountId: string, permission: ConsumerPermission): void {
    const connectionId = this.connectionId(id);
    const parsed = permissionSchema.parse(permission);
    if (!accountId || (parsed.scope === "selected" && !parsed.resources?.length)) throw new ConsumerAccessError("identity.setup_required");
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM identity_connections WHERE workspace = ? AND id = ?").get(this.workspaceId, connectionId);
      if (existing) throw new ConsumerAccessError("identity.setup_required");
      this.db.prepare("INSERT INTO identity_connections(workspace, id, config, secret, active) VALUES (?, ?, ?, NULL, 1)")
        .run(this.workspaceId, connectionId, JSON.stringify({ kind: "service", id: connectionId, status: "active" }));
      this.assign(connectionId, `service:${connectionId}`, accountId, "service", parsed);
    })();
  }

  openServiceAuthority(agentId: string): ConsumerAuthority {
    const rows = this.db.prepare(`SELECT p.connection, p.subject, p.permission, c.config FROM identity_principals p
      JOIN identity_connections c ON c.workspace = p.workspace AND c.id = p.connection
      WHERE p.workspace = ? AND p.active = 1 AND c.active = 1 AND p.subject LIKE 'service:%'`)
      .all(this.workspaceId) as Array<{ connection: string; subject: string; permission: string; config: string }>;
    const matches = rows.filter((row) => {
      const config = JSON.parse(row.config) as { kind?: string };
      if (config.kind !== "service" || !row.subject.startsWith("service:")) return false;
      const permission = permissionSchema.safeParse(JSON.parse(row.permission));
      return permission.success && permission.data.agents.includes(agentId) && permission.data.actions.includes("conversation:use");
    });
    if (matches.length !== 1) throw new ConsumerAccessError("identity.not_available");
    const match = matches[0]!;
    const token = this.establishSession(match.connection, agentId, match.subject, `service:${randomUUID()}`, this.now() + SERVICE_SESSION_MS);
    return this.resolve(this.digest(token), agentId);
  }

  narrowAuthority(parent: ConsumerAuthority, childAgentId: string, narrowing: { actions?: string[]; resources?: string[] | null; expiresAt?: number }): ConsumerAuthority {
    const live = this.resolve(parent.sessionId, parent.agentId);
    if (live.principal.id !== parent.principal.id || live.principal.revision !== parent.principal.revision || live.grantId !== parent.grantId) {
      throw new ConsumerAccessError("identity.not_available");
    }
    const request = narrowing as { actions?: string[]; resources?: string[] | null; expiresAt?: number; subject?: string; principalId?: string };
    if (request.subject !== undefined && request.subject !== live.principal.subject) throw new ConsumerAccessError("identity.not_available");
    if (request.principalId !== undefined && request.principalId !== live.principal.id) throw new ConsumerAccessError("identity.not_available");
    if (!childAgentId || !live.principal.permission.agents.includes(childAgentId)) throw new ConsumerAccessError("identity.not_available");
    let actions = live.actions;
    if (request.actions !== undefined) {
      if (request.actions.some((action) => !live.actions.includes(action))) throw new ConsumerAccessError("identity.not_available");
      actions = live.actions.filter((action) => request.actions!.includes(action));
    }
    let resources = live.resources;
    if (request.resources != null) {
      const parentResources = live.resources;
      if (parentResources && request.resources.some((id) => !parentResources.includes(id))) throw new ConsumerAccessError("identity.not_available");
      resources = [...request.resources];
    }
    let expiresAt = live.expiresAt;
    if (request.expiresAt !== undefined) {
      if (!Number.isFinite(request.expiresAt) || request.expiresAt > live.expiresAt) throw new ConsumerAccessError("identity.not_available");
      expiresAt = request.expiresAt;
    }
    if (expiresAt <= this.now()) throw new ConsumerAccessError("identity.not_available");
    const evidenceAt = this.evidenceAt(live.sessionId);
    const token = randomBytes(32).toString("base64url");
    const sessionId = this.digest(token);
    const grantId = randomUUID();
    this.db.transaction(() => {
      const current = this.resolve(live.sessionId, live.agentId);
      if (current.principal.revision !== live.principal.revision || current.grantId !== live.grantId || current.expiresAt !== live.expiresAt
        || JSON.stringify(current.actions) !== JSON.stringify(live.actions) || JSON.stringify(current.resources) !== JSON.stringify(live.resources)) {
        throw new ConsumerAccessError("identity.not_available");
      }
      this.db.prepare(`INSERT INTO identity_sessions(workspace, id, principal, agent, expires, principal_revision, parent_session, evidence_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(this.workspaceId, sessionId, live.principal.id, childAgentId, expiresAt, live.principal.revision, live.sessionId, evidenceAt);
      this.db.prepare("INSERT INTO identity_grants(workspace, id, session, actions, resources, expires) VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, grantId, sessionId, JSON.stringify(actions), resources ? JSON.stringify(resources) : null, expiresAt);
    })();
    return this.resolve(sessionId, childAgentId);
  }

  touchEvidence(sessionId: string, at: number): void {
    const result = this.db.prepare("UPDATE identity_sessions SET evidence_at = ? WHERE workspace = ? AND id = ?").run(at, this.workspaceId, sessionId);
    if (result.changes !== 1) throw new ConsumerAccessError("identity.not_available");
  }

  evidenceAt(sessionId: string): number | null {
    const row = this.db.prepare("SELECT evidence_at FROM identity_sessions WHERE workspace = ? AND id = ?")
      .get(this.workspaceId, sessionId) as { evidence_at: number | null } | undefined;
    return row?.evidence_at ?? null;
  }

  saveRefreshSecret(sessionId: string, token: string | null): void {
    if (token !== null && (token.length < 8 || token.length > 512 || /\s/.test(token))) throw new ConsumerAccessError("identity.not_available");
    const result = this.db.prepare("UPDATE identity_sessions SET refresh_secret = ? WHERE workspace = ? AND id = ?").run(token, this.workspaceId, sessionId);
    if (result.changes !== 1) throw new ConsumerAccessError("identity.not_available");
  }

  refreshSecret(sessionId: string): string | null {
    const row = this.db.prepare("SELECT refresh_secret FROM identity_sessions WHERE workspace = ? AND id = ?")
      .get(this.workspaceId, sessionId) as { refresh_secret: string | null } | undefined;
    return row?.refresh_secret ?? null;
  }

  refreshMaterial(sessionId: string): { holderId: string; secret: string } | null {
    const seen = new Set<string>();
    let current: string | null = sessionId;
    while (current && !seen.has(current) && seen.size < 8) {
      seen.add(current);
      const row = this.db.prepare("SELECT refresh_secret, parent_session, active FROM identity_sessions WHERE workspace = ? AND id = ?")
        .get(this.workspaceId, current) as { refresh_secret: string | null; parent_session: string | null; active: number } | undefined;
      if (!row || row.active !== 1) return null;
      if (typeof row.refresh_secret === "string" && row.refresh_secret.length > 0) return { holderId: current, secret: row.refresh_secret };
      current = row.parent_session;
    }
    return null;
  }

  sessionProtection(sessionId: string): SessionProtection {
    const row = this.db.prepare(`SELECT s.evidence_at, c.id AS connection_id, c.config FROM identity_sessions s
      JOIN identity_principals p ON p.workspace = s.workspace AND p.id = s.principal
      JOIN identity_connections c ON c.workspace = p.workspace AND c.id = p.connection
      WHERE s.workspace = ? AND s.id = ?`)
      .get(this.workspaceId, sessionId) as { evidence_at: number | null; connection_id: string; config: string } | undefined;
    if (!row) throw new ConsumerAccessError("identity.not_available");
    const config = JSON.parse(row.config) as { kind?: string; issuer?: string; freshnessMs?: number; revocationUrl?: string | null };
    const kind = config.kind === "oidc" || config.kind === "service" ? config.kind : "handoff";
    const freshnessMs = kind === "oidc" && validFreshness(config.freshnessMs) ? config.freshnessMs : DEFAULT_OIDC_FRESHNESS_MS;
    return { kind, connectionId: row.connection_id, issuer: typeof config.issuer === "string" ? config.issuer : null,
      evidenceAt: row.evidence_at, freshnessMs, revocationUrl: typeof config.revocationUrl === "string" ? config.revocationUrl : null,
      hasRefresh: this.refreshMaterial(sessionId) !== null };
  }

  close(): void { this.db.close(); }

  private connectionId(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConsumerAccessError("identity.setup_required");
    return id;
  }

  private connectionConfig(id: string, activeOnly: boolean): Record<string, unknown> {
    const row = this.db.prepare(`SELECT config FROM identity_connections WHERE workspace = ? AND id = ? ${activeOnly ? "AND active = 1" : ""}`)
      .get(this.workspaceId, id) as { config: string } | undefined;
    if (!row) throw new ConsumerAccessError(activeOnly ? "identity.verification_required" : "identity.setup_required");
    return JSON.parse(row.config) as Record<string, unknown>;
  }

  private readStoredOidc(id: string): OidcStored {
    const config = this.connectionConfig(id, false);
    if (config.kind !== "oidc" || config.subjectClaim !== "sub" || typeof config.secret === "string") {
      throw new ConsumerAccessError("identity.setup_required");
    }
    return config as OidcStored;
  }

  private publicOidc(config: OidcStored): OidcConnection {
    return { id: config.id, issuer: config.issuer, clientId: config.clientId, agentId: config.agentId, redirectUri: config.redirectUri,
      algorithms: config.algorithms, subjectClaim: "sub", status: config.status };
  }

  private writeOidc(config: OidcStored, active: 0 | 1): void {
    this.db.prepare("UPDATE identity_connections SET config = ?, active = ? WHERE workspace = ? AND id = ?")
      .run(JSON.stringify({ ...config, kind: "oidc" }), active, this.workspaceId, config.id);
  }

  private connectionRow(id: string): { config: string; active: number } {
    const row = this.db.prepare("SELECT config, active FROM identity_connections WHERE workspace = ? AND id = ?")
      .get(this.workspaceId, id) as { config: string; active: number } | undefined;
    if (!row) throw new ConsumerAccessError("identity.setup_required");
    return row;
  }

  private connectionView(row: { id: string; config: string; active: number }): ConsumerConnectionView {
    const config = JSON.parse(row.config) as Record<string, unknown>;
    const kind = config.kind === "oidc" || config.kind === "service" ? config.kind : "handoff";
    const stored = config.status;
    let status: ConsumerConnectionView["status"] = stored === "draft" || stored === "validated" || stored === "active" || stored === "disabled"
      ? stored : row.active === 1 ? "active" : "disabled";
    if (row.active !== 1 && (status === "active" || kind !== "oidc")) status = "disabled";
    let callbackPath: string | null = null;
    if (kind === "oidc" && typeof config.redirectUri === "string") {
      try { callbackPath = new URL(config.redirectUri).pathname; } catch { callbackPath = null; }
    }
    const connected = typeof config.revocationUrl === "string" && config.revocationUrl.length > 0;
    return { id: row.id, kind, active: row.active === 1, status, callbackPath,
      issuer: kind === "service" || typeof config.issuer !== "string" ? null : config.issuer,
      issuerChecks: kind === "oidc" ? [...OIDC_ISSUER_CHECKS] : [],
      upstreamRevocation: connected ? "connected" : "local_only",
      upstreamNote: connected ? CONNECTED_REVOCATION_NOTE : LOCAL_REVOCATION_NOTE };
  }

  private deactivateDescendants(sessionId: string): void {
    const children = this.db.prepare("SELECT id FROM identity_sessions WHERE workspace = ? AND parent_session = ? AND active = 1")
      .all(this.workspaceId, sessionId) as Array<{ id: string }>;
    for (const child of children) {
      this.db.prepare("UPDATE identity_sessions SET active = 0 WHERE workspace = ? AND id = ?").run(this.workspaceId, child.id);
      this.db.prepare("UPDATE identity_grants SET active = 0 WHERE workspace = ? AND session = ?").run(this.workspaceId, child.id);
      this.deactivateDescendants(child.id);
    }
  }

  private digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
}

function validClientSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 512 && !/[\r\n]/.test(value);
}

function validFreshness(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 86_400_000;
}
