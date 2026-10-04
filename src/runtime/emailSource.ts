import path from "node:path";
import { ImapFlow } from "imapflow";
import { getCatalogScanPaths } from "../config/browseCatalog.js";
import { loadTriggerOutcome } from "../config/loadTrigger.js";
import { catalogContextFromStageflow } from "../config/resolveCatalogContext.js";
import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import type { RunStore } from "../runstore/port.js";
import type { TaskFile } from "../types/task.js";
import type { TriggerFile } from "../types/trigger.js";
import { matchesEventFilter } from "./triggerEventMatch.js";
import type { TriggerFireEvent, TriggerSourcePort } from "./triggerPort.js";

export const DEFAULT_EMAIL_RECONNECT_BASE_DELAY_MS = 1_000;
export const DEFAULT_EMAIL_RECONNECT_MAX_DELAY_MS = 30_000;
export const EMAIL_TEXT_EXCERPT_MAX_CHARS = 2_000;

export type NormalizedEmailMessage = {
  uid: number;
  from: string;
  subject: string;
  date: string;
  text: string;
};

export type EmailClientConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/**
 * Narrow, test-friendly seam over "one IMAP/IDLE mailbox connection". The
 * default implementation adapts `imapflow`'s `ImapFlow`; tests inject a fake
 * so no real mailbox is ever contacted.
 */
export type EmailImapClient = {
  connect(): Promise<{ uidNext: number }>;
  idle(): void;
  fetchNewMessages(sinceUid: number): Promise<NormalizedEmailMessage[]>;
  close(): Promise<void>;
  onExists(listener: () => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
};

function defaultCreateEmailClient(config: EmailClientConfig): EmailImapClient {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993 || config.port === 465,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });

  return {
    async connect() {
      await client.connect();
      const mailbox = await client.mailboxOpen("INBOX");
      return { uidNext: mailbox.uidNext };
    },
    idle() {
      void client.idle().catch(() => {
        // Connection drop surfaces via the 'close'/'error' events below.
      });
    },
    async fetchNewMessages(sinceUid) {
      if (sinceUid <= 0) return [];
      const results: NormalizedEmailMessage[] = [];
      for await (const msg of client.fetch(
        `${sinceUid + 1}:*`,
        { uid: true, envelope: true, bodyParts: ["TEXT"] },
        { uid: true },
      )) {
        if (msg.uid <= sinceUid) continue;
        const fromAddr = msg.envelope?.from?.[0];
        const from = fromAddr?.address ?? fromAddr?.name ?? "";
        const subject = msg.envelope?.subject ?? "";
        const rawDate = msg.envelope?.date;
        const date = rawDate instanceof Date ? rawDate.toISOString() : String(rawDate ?? "");
        const text = msg.bodyParts?.get("TEXT")?.toString("utf8").slice(0, EMAIL_TEXT_EXCERPT_MAX_CHARS) ?? "";
        results.push({ uid: msg.uid, from, subject, date, text });
      }
      return results;
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
    onExists(listener) {
      client.on("exists", () => listener());
    },
    onClose(listener) {
      client.on("close", () => listener());
    },
    onError(listener) {
      client.on("error", (err) => listener(err));
    },
  };
}

type MailboxConfig = { host: string; port: number; user: string; secretRef: string };

function parseMailboxConfig(definition: TriggerFile): MailboxConfig | undefined {
  const config = definition.event?.config;
  const host = config?.host;
  const port = config?.port;
  const user = config?.user;
  const secretRef = config?.secretRef;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    typeof user !== "string" ||
    user.length === 0 ||
    typeof secretRef !== "string" ||
    secretRef.length === 0
  ) {
    return undefined;
  }
  return { host, port, user, secretRef };
}

function mailboxKeyFor(config: MailboxConfig): string {
  return `email:${config.host}:${config.port}:${config.user}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type MailboxGroup = {
  config: MailboxConfig;
  matches: Array<{ path: string; definition: TriggerFile }>;
};

type MailboxConnection = {
  group: MailboxGroup;
  onFire: (event: TriggerFireEvent) => Promise<void>;
  client?: EmailImapClient;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  stopping: boolean;
};

export type EmailSourceOptions = {
  store: RunStore;
  cwd?: string;
  logError?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Injectable client factory so tests never hit a real mailbox. */
  createEmailClient?: (config: EmailClientConfig) => EmailImapClient;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
};

/**
 * `TriggerSourcePort` adapter for `event`-kind triggers whose `event.source`
 * starts with `email.`. Unlike the poll-based adapters this one is push-based:
 * on `start()` it groups triggers by distinct mailbox (`host`+`port`+`user`),
 * opens exactly one real IMAP/IDLE connection per mailbox regardless of how
 * many triggers watch it, and reacts to the server's new-message
 * notification instead of ticking on an interval. A dropped connection
 * reconnects with bounded exponential backoff rather than going dark.
 */
export class EmailSource implements TriggerSourcePort {
  private readonly store: RunStore;
  private readonly cwd: string;
  private readonly logError: (message: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createEmailClient: (config: EmailClientConfig) => EmailImapClient;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly connections = new Map<string, MailboxConnection>();
  private stopped = false;

  constructor(options: EmailSourceOptions) {
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.logError =
      options.logError ??
      ((message: string) => {
        console.error(message);
      });
    this.env = options.env ?? process.env;
    this.createEmailClient = options.createEmailClient ?? defaultCreateEmailClient;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_EMAIL_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_EMAIL_RECONNECT_MAX_DELAY_MS;
  }

  async start(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void> {
    this.stopped = false;
    const ctx = catalogContextFromStageflow(await resolveStageflowContext(this.cwd));
    const scanPaths = await getCatalogScanPaths(ctx);
    if (!scanPaths) return;

    const projectRoot = ctx.projectRoot ?? undefined;
    const groups = await this.discover(scanPaths.triggerPaths);

    for (const [mailboxKey, group] of groups) {
      for (const match of group.matches) {
        const definitionRef =
          projectRoot !== undefined
            ? path.relative(projectRoot, match.path).replace(/\\/g, "/")
            : match.path;
        await this.store.upsertTrigger({
          id: match.definition.id,
          definitionRef,
          enabled: true,
        });
      }
      await this.connectMailbox(mailboxKey, group, onFire);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [mailboxKey, conn] of this.connections) {
      conn.stopping = true;
      if (conn.reconnectTimer !== undefined) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = undefined;
      }
      if (conn.client) {
        try {
          await conn.client.close();
        } catch (err) {
          this.logError(`email: closing mailbox "${mailboxKey}" failed: ${errMsg(err)}`);
        }
      }
    }
    this.connections.clear();
  }

  private async discover(triggerPaths: string[]): Promise<Map<string, MailboxGroup>> {
    const groups = new Map<string, MailboxGroup>();
    for (const triggerPath of triggerPaths) {
      const outcome = await loadTriggerOutcome(triggerPath);
      if (!outcome.ok) continue;
      const definition = outcome.value;
      if (definition.kind !== "event" || !definition.enabled) continue;
      const source = definition.event?.source;
      if (typeof source !== "string" || !source.startsWith("email.")) continue;

      const config = parseMailboxConfig(definition);
      if (!config) {
        this.logError(
          `email: trigger "${definition.id}" has incomplete event.config ` +
            `(expected host, port, user, secretRef); skipping`,
        );
        continue;
      }

      const mailboxKey = mailboxKeyFor(config);
      const group = groups.get(mailboxKey) ?? { config, matches: [] };
      group.matches.push({ path: triggerPath, definition });
      groups.set(mailboxKey, group);
    }
    return groups;
  }

  private async connectMailbox(
    mailboxKey: string,
    group: MailboxGroup,
    onFire: (event: TriggerFireEvent) => Promise<void>,
  ): Promise<void> {
    let conn = this.connections.get(mailboxKey);
    if (!conn) {
      conn = { group, onFire, reconnectAttempt: 0, stopping: false };
      this.connections.set(mailboxKey, conn);
    }
    if (conn.stopping || this.stopped) return;

    let password: string | undefined;
    try {
      password = readSecretFromEnvOrFile(this.env, group.config.secretRef);
    } catch (err) {
      this.logError(
        `email: failed to read secret "${group.config.secretRef}" for mailbox "${mailboxKey}": ${errMsg(err)}`,
      );
      return;
    }
    if (password === undefined) {
      this.logError(
        `email: secret "${group.config.secretRef}" is not set for mailbox "${mailboxKey}"; skipping`,
      );
      return;
    }

    const client = this.createEmailClient({
      host: group.config.host,
      port: group.config.port,
      user: group.config.user,
      password,
    });
    conn.client = client;

    client.onError((err) => {
      this.logError(`email: mailbox "${mailboxKey}" error: ${errMsg(err)}`);
    });
    client.onClose(() => {
      const current = this.connections.get(mailboxKey);
      if (this.stopped || !current || current.stopping) return;
      this.scheduleReconnect(mailboxKey);
    });
    client.onExists(() => {
      void this.processNewMail(mailboxKey).catch((err) => {
        this.logError(`email: processing new mail for mailbox "${mailboxKey}" failed: ${errMsg(err)}`);
      });
    });

    try {
      const { uidNext } = await client.connect();
      const existing = await this.store.getTriggerAdapterState(mailboxKey, "uid");
      if (existing === null) {
        await this.store.setTriggerAdapterState(mailboxKey, "uid", String(Math.max(uidNext - 1, 0)));
      }
      client.idle();
      conn.reconnectAttempt = 0;
    } catch (err) {
      this.logError(`email: connecting to mailbox "${mailboxKey}" failed: ${errMsg(err)}`);
      this.scheduleReconnect(mailboxKey);
    }
  }

  private scheduleReconnect(mailboxKey: string): void {
    const conn = this.connections.get(mailboxKey);
    if (!conn || conn.stopping || this.stopped) return;
    const attempt = conn.reconnectAttempt;
    const delay = Math.min(this.reconnectBaseDelayMs * 2 ** attempt, this.reconnectMaxDelayMs);
    conn.reconnectAttempt = attempt + 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      void this.connectMailbox(mailboxKey, conn.group, conn.onFire);
    }, delay).unref();
  }

  private async processNewMail(mailboxKey: string): Promise<void> {
    const conn = this.connections.get(mailboxKey);
    if (!conn?.client) return;
    const watermarkRaw = await this.store.getTriggerAdapterState(mailboxKey, "uid");
    const sinceUid = watermarkRaw !== null ? Number(watermarkRaw) : 0;
    const messages = await conn.client.fetchNewMessages(sinceUid);
    if (messages.length === 0) return;

    let maxUid = sinceUid;
    for (const message of messages) {
      if (message.uid <= sinceUid) continue;
      if (message.uid > maxUid) maxUid = message.uid;
      const summary: Record<string, unknown> = {
        from: message.from,
        subject: message.subject,
        date: message.date,
        text: message.text,
      };
      for (const { definition } of conn.group.matches) {
        if (!matchesEventFilter(definition.event?.match, summary)) continue;
        await this.fireSafely(conn.onFire, definition, message, summary);
      }
    }

    if (maxUid > sinceUid) {
      await this.store.setTriggerAdapterState(mailboxKey, "uid", String(maxUid));
    }
  }

  private async fireSafely(
    onFire: (event: TriggerFireEvent) => Promise<void>,
    definition: TriggerFile,
    message: NormalizedEmailMessage,
    summary: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (definition.task !== undefined) {
        await onFire({ triggerId: definition.id });
        return;
      }
      const task: TaskFile = {
        id: `${definition.id}-email-${message.uid}`,
        goal: `Handle email: ${message.subject}`,
        input: summary,
      };
      await onFire({ triggerId: definition.id, task });
    } catch (err) {
      this.logError(`email: firing trigger "${definition.id}" failed: ${errMsg(err)}`);
    }
  }
}
