import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { storeRootFor } from "../runstore/paths.js";
import { EmailError, type EmailAccountStatus } from "./port.js";

const authSchema = z.object({
  type: z.enum(["password", "oauth2"]),
  secretRef: z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/),
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
  searchWorkLimit: z.number().int().min(1).max(10000).default(1000),
  sentFolder: z.string().min(1).max(200).optional(),
}).strict();

export type EmailAccountInput = z.input<typeof accountSchema>;
export type EmailConnection = z.output<typeof connectionSchema>;
export type EmailAccount = z.output<typeof accountSchema> & { accountId: string; scope: string };
type AccountState = { version: 1; scope: string; accounts: EmailAccount[]; health: Record<string, EmailAccountStatus> };

function parseAccount(input: unknown): z.output<typeof accountSchema> {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) throw new EmailError("EMAIL_INVALID_INPUT");
  for (const connection of [parsed.data.imap, parsed.data.smtp]) {
    if (connection.tls === "none" && (!parsed.data.allowInsecureLocalDevelopment ||
      !["127.0.0.1", "::1", "localhost"].includes(connection.host.toLowerCase()))) {
      throw new EmailError("EMAIL_INVALID_INPUT");
    }
  }
  return parsed.data;
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
      } catch {
        throw new EmailError("EMAIL_INVALID_INPUT");
      }
    }
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
  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export function resolveEmailSecret(connection: EmailConnection, env: NodeJS.ProcessEnv = process.env): string {
  if (connection.auth.type === "oauth2" && connection.auth.expiresAt &&
    Date.parse(connection.auth.expiresAt) <= Date.now()) throw new EmailError("EMAIL_TOKEN_EXPIRED");
  const secret = env[connection.auth.secretRef.slice(4)];
  if (!secret) throw new EmailError("EMAIL_AUTH_FAILED");
  return secret;
}
