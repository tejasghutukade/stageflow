import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { storeRootFor } from "../runstore/paths.js";
import { EmailError, type EmailAccountStatus } from "./port.js";
import { attachmentLimitsSchema } from "./attachments.js";

const localSecrets = new Map<string, string>();

const authSchema = z.object({
  type: z.enum(["password", "oauth2"]),
  secretRef: z.string().regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|local:[a-f0-9]{64})$/),
  expiresAt: z.iso.datetime().optional(),
}).strict().refine(auth => auth.type !== "oauth2" || auth.expiresAt !== undefined);
const connectionSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(320),
  tls: z.enum(["implicit", "starttls", "none"]).default("implicit"),
  auth: authSchema,
}).strict();
const accountSchema = z.object({
  displayName: z.string().min(1).max(200), address: z.email(), enabled: z.boolean().default(true),
  adapter: z.literal("local").default("local"),
  folders: z.array(z.string().min(1).max(200)).min(1).max(20).default(["INBOX"]),
  senderAliases: z.array(z.email()).max(20).default([]),
  imap: connectionSchema, smtp: connectionSchema,
  allowInsecureLocalDevelopment: z.boolean().default(false),
  connectionTimeoutMs: z.number().int().min(100).max(60000).default(10000),
  pollingIntervalMs: z.number().int().min(1000).max(3600000).default(60000),
  reconnectMaxDelayMs: z.number().int().min(1000).max(3600000).default(60000),
  searchWorkLimit: z.number().int().min(1).max(10000).default(1000),
  attachmentLimits: attachmentLimitsSchema.default({ count: 10, perFileBytes: 2097152, totalBytes: 5242880, downloadBytes: 8388608 }),
  sentFolder: z.string().min(1).max(200).optional(),
  sentCopyPolicy: z.enum(["provider-managed", "imap-append"]).default("provider-managed"),
  sentCopyMaxBytes: z.number().int().min(1).max(50331648).default(8388608),
}).strict();

export type EmailAccountInput = z.input<typeof accountSchema>;
export type EmailConnection = z.output<typeof connectionSchema>;
export type EmailAccount = z.output<typeof accountSchema> & { accountId: string; scope: string };
type AccountState = { version: 1; scope: string; accounts: EmailAccount[]; health: Record<string, EmailAccountStatus>; yamlManagedAccountIds?: string[] };
const yamlFileLimit = 262144;
const yamlFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.object({ accountId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) }).passthrough()).max(100),
}).strict();

function parseAccount(input: unknown): z.output<typeof accountSchema> {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) throw new EmailError("EMAIL_INVALID_INPUT");
  if (parsed.data.sentCopyPolicy === "imap-append" && !parsed.data.sentFolder) throw new EmailError("EMAIL_INVALID_INPUT");
  for (const connection of [parsed.data.imap, parsed.data.smtp]) {
    if (connection.tls === "none" && (!parsed.data.allowInsecureLocalDevelopment ||
      !["127.0.0.1", "::1", "localhost"].includes(connection.host.toLowerCase()))) {
      throw new EmailError("EMAIL_INVALID_INPUT");
    }
  }
  return parsed.data;
}

function startupAccounts(file: string, scope: string): EmailAccount[] {
  let descriptor: number;
  try { descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new EmailError("EMAIL_STORAGE_FAILED");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new EmailError("EMAIL_INVALID_INPUT");
    if (stat.size > yamlFileLimit) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    const bytes = Buffer.alloc(yamlFileLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > yamlFileLimit) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    const document = parseDocument(bytes.toString("utf8", 0, length), { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new EmailError("EMAIL_INVALID_INPUT");
    const parsed = yamlFileSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!parsed.success) throw new EmailError("EMAIL_INVALID_INPUT");
    const ids = new Set<string>();
    const pendingSecrets = new Map<string, string>();
    const configured = parsed.data.accounts.map(({ accountId, ...input }) => {
      if (ids.has(accountId)) throw new EmailError("EMAIL_INVALID_INPUT");
      ids.add(accountId);
      const normalized = structuredClone(input);
      for (const protocol of ["imap", "smtp"] as const) {
        const connection = normalized[protocol] as { host?: string; auth?: Record<string, unknown> } | undefined;
        const auth = connection?.auth;
        if (auth?.type !== "password") continue;
        let password = auth.password;
        if (password === undefined && typeof auth.secretRef === "string"
          && !auth.secretRef.startsWith("env:") && !auth.secretRef.startsWith("local:")) {
          password = auth.secretRef;
        }
        if (password === undefined) continue;
        if (typeof password !== "string" || !password.length || (auth.password !== undefined && auth.secretRef !== undefined)) throw new EmailError("EMAIL_INVALID_INPUT");
        const reference = `local:${createHash("sha256").update(JSON.stringify([scope, accountId, protocol])).digest("hex")}`;
        const gmailAppPassword = connection?.host?.endsWith(".gmail.com") && /^[a-z]{4}( [a-z]{4}){3}$/.test(password);
        pendingSecrets.set(reference, gmailAppPassword ? password.replaceAll(" ", "") : password);
        delete auth.password;
        auth.secretRef = reference;
      }
      return { ...parseAccount(normalized), accountId, scope };
    });
    for (const [reference, secret] of pendingSecrets) localSecrets.set(reference, secret);
    return configured;
  } catch (error) {
    if (error instanceof EmailError) throw error;
    throw new EmailError("EMAIL_INVALID_INPUT");
  } finally { closeSync(descriptor); }
}

/** Host-owned configuration. Reads return copies; mutations replace the file atomically. */
export class EmailAccounts {
  readonly scope: string;
  private readonly file: string;
  private state: AccountState;
  private readonly listeners = new Set<(accountId: string) => void>();

  constructor(cwd: string) {
    this.scope = path.resolve(cwd);
    this.file = path.join(storeRootFor(cwd), "email-accounts.json");
    this.state = { version: 1, scope: this.scope, accounts: [], health: {} };
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, "utf8")) as AccountState;
        if (saved.version !== 1 || saved.scope !== this.scope || !Array.isArray(saved.accounts)) {
          throw new Error();
        }
        this.state = { ...saved, accounts: saved.accounts.map(({ accountId, scope, ...input }) => {
          if (typeof accountId !== "string" || scope !== this.scope) throw new Error();
          return { ...parseAccount(input), accountId, scope };
        }) };
        const ids = this.state.accounts.map(account => account.accountId);
        const managed = saved.yamlManagedAccountIds ?? [];
        if (new Set(ids).size !== ids.length || !Array.isArray(managed) || new Set(managed).size !== managed.length
          || managed.some(id => typeof id !== "string" || !ids.includes(id))) throw new Error();
      } catch {
        throw new EmailError("EMAIL_INVALID_INPUT");
      }
    }
    this.syncStartupAccounts(startupAccounts(path.join(this.scope, "email.yaml"), this.scope));
  }

  list(): EmailAccount[] {
    return structuredClone(this.state.accounts);
  }
  get(accountId: string, requireEnabled = true): EmailAccount {
    const account = this.state.accounts.find(a => a.accountId === accountId && a.scope === this.scope);
    if (!account) throw new EmailError("EMAIL_ACCOUNT_NOT_FOUND");
    if (requireEnabled && !account.enabled) throw new EmailError("EMAIL_ACCOUNT_DISABLED");
    return structuredClone(account);
  }
  create(input: unknown): EmailAccount {
    const account = { ...parseAccount(input), accountId: randomUUID(), scope: this.scope };
    this.state.accounts.push(account);
    this.persist();
    this.notify(account.accountId);
    return structuredClone(account);
  }
  update(accountId: string, patch: unknown): EmailAccount {
    this.requireHttpAccount(accountId);
    const { accountId: _id, scope: _scope, ...current } = this.get(accountId, false);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new EmailError("EMAIL_INVALID_INPUT");
    const account = { ...parseAccount({ ...current, ...patch }), accountId, scope: this.scope };
    this.state.accounts = this.state.accounts.map(a => a.accountId === accountId ? account : a);
    delete this.state.health[accountId];
    this.persist();
    this.notify(accountId);
    return structuredClone(account);
  }
  remove(accountId: string): void {
    this.requireHttpAccount(accountId);
    this.get(accountId, false);
    this.state.accounts = this.state.accounts.filter(a => a.accountId !== accountId);
    delete this.state.health[accountId];
    this.persist();
    this.notify(accountId);
  }
  health(accountId: string): EmailAccountStatus | undefined {
    this.get(accountId, false);
    return structuredClone(this.state.health[accountId]);
  }
  recordHealth(status: EmailAccountStatus): void {
    this.get(status.accountId);
    this.state.health[status.accountId] = structuredClone(status);
    this.persist();
  }
  onChange(listener: (accountId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(accountId: string): void {
    for (const listener of this.listeners) listener(accountId);
  }
  private requireHttpAccount(accountId: string): void {
    if (this.state.yamlManagedAccountIds?.includes(accountId)) throw new EmailError("EMAIL_OPERATION_CONFLICT");
  }
  private syncStartupAccounts(configured: EmailAccount[]): void {
    const managed = new Set(this.state.yamlManagedAccountIds ?? []);
    for (const account of configured) {
      if (!managed.has(account.accountId) && this.state.accounts.some(saved => saved.accountId === account.accountId)) {
        throw new EmailError("EMAIL_OPERATION_CONFLICT");
      }
    }
    const declared = new Map(configured.map(account => [account.accountId, account]));
    const changed = new Set<string>();
    const accounts = this.state.accounts.map(saved => {
      const replacement = declared.get(saved.accountId);
      declared.delete(saved.accountId);
      const account = replacement ?? (managed.has(saved.accountId) ? { ...saved, enabled: false } : saved);
      if (JSON.stringify(account) !== JSON.stringify(saved)) changed.add(saved.accountId);
      return account;
    });
    for (const account of declared.values()) { accounts.push(account); changed.add(account.accountId); }
    for (const account of configured) managed.add(account.accountId);
    if (!changed.size) return;
    const next = { ...this.state, accounts, health: { ...this.state.health }, yamlManagedAccountIds: [...managed] };
    for (const accountId of changed) delete next.health[accountId];
    try { this.persist(next); }
    catch { throw new EmailError("EMAIL_STORAGE_FAILED"); }
    this.state = next;
  }
  private persist(state = this.state): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* A failed write might not create a temporary file. */ }
      throw error;
    }
  }
}

export function resolveEmailSecret(connection: EmailConnection, env: NodeJS.ProcessEnv = process.env): string {
  if (connection.auth.type === "oauth2" && connection.auth.expiresAt &&
    Date.parse(connection.auth.expiresAt) <= Date.now()) throw new EmailError("EMAIL_TOKEN_EXPIRED");
  const secret = connection.auth.secretRef.startsWith("local:")
    ? localSecrets.get(connection.auth.secretRef)
    : env[connection.auth.secretRef.slice(4)];
  if (!secret) throw new EmailError("EMAIL_AUTH_FAILED");
  return secret;
}
