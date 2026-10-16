import { grantedStageflowTools } from "../toolkit/meta.js";
import { senderAllowed } from "./communications/allowlist.js";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  grantedBuiltinTools,
  parseAgentDefinition,
  parseAgentYaml,
  serializeAgentDefinition,
  type AgentDefinition,
  type AgentIssue,
} from "../config/loadAgent.js";
import { agentThreadKey, inboundDedupeKey, type AgentInboundMessage } from "./communications/port.js";
import { generateAgentId } from "./agentId.js";
import { newWebChatSlug } from "./webChat/slug.js";
import { ApprovalBroker } from "./approvalBroker.js";
import { deliveryLedger, scheduleLedger, type DeliveryLedger, type ScheduleLedger } from "./ledgers.js";
import { TurnLifecycle, type FinishInput } from "./turnLifecycle.js";
import { AgentError } from "./errors.js";
import { diffLines, type DiffLine } from "./lineDiff.js";
import { exportTurnsToOtlp } from "./otlpExport.js";
import { canApprove, effectiveAskFirst, isToolGranted, requiresAskFirst } from "./policy.js";
import {
  agentProjectKey,
  AgentStore,
  type AgentApproval,
  type AgentDefinitionRow,
  type AgentEvalScore,
  type AgentMessage,
  type AgentRevision,
  type AgentRevisionMeta,
  type AgentSession,
  type AgentSessionListItem,
  type AgentDelivery,
  type AgentSpan,
  type AgentTurn,
  type ApprovalActor,
  type RevisionSource,
  type SessionQuery,
  type SessionStats,
  type SessionStatus,
} from "./store.js";

/** Lookups outside the agents directory, used only to produce non-blocking warnings. */
export type AgentEnvironment = {
  /** Server names in the project's `.mcp.json`, or undefined when there is no usable catalog. */
  mcpServerNames(projectRoot: string): Promise<string[] | undefined>;
  skillNames(projectRoot: string): Promise<string[] | undefined>;
  connectionIds(): Promise<string[] | undefined>;
  /** What a connection talks to (inbox, Photon project), so two connections on one inbox count as one channel. */
  connectionIdentity?(connectionId: string): Promise<string | undefined>;
  /** What the model catalog says about an id, or undefined when it cannot be checked. */
  modelInfo?(id: string): Promise<{ known: boolean; nativeTools: boolean } | undefined>;
};

const NO_ENVIRONMENT: AgentEnvironment = {
  mcpServerNames: async () => undefined,
  skillNames: async () => undefined,
  connectionIds: async () => undefined,
};

export type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  revision: number;
  /** Problems with the file on disk; a non-empty list on a revision-0 agent means it never loaded. */
  issues: AgentIssue[];
  model: AgentDefinition["model"] | null;
  tools: { builtin: string[]; builtinTools: string[]; mcpServers: string[]; skills: string[]; browser: boolean };
  askFirst: string[];
  /** Connection the agent answers on, if any. */
  channelConnection: string | null;
  /** Cron expression when the agent starts sessions on a schedule. */
  scheduleCron: string | null;
  subAgents: string[];
  capture: AgentDefinition["observability"]["capture"] | null;
  /** Path of the public chat page (`/chat/<slug>`) while web chat is switched on and has a link. */
  webChatUrl: string | null;
  stats: SessionStats;
  pendingApprovals: number;
  updatedAt: string;
};

/** Tools that return session transcripts, which hold visitors' messages. */
const CONVERSATION_READING_TOOLS = new Set(["get_agent_session", "list_agent_sessions"]);

export type AgentDetail = {
  agent: AgentSummary;
  definition: AgentDefinition | null;
  yaml: string | null;
  warnings: AgentIssue[];
};

export type ValidationResult = {
  definition: AgentDefinition | null;
  issues: AgentIssue[];
  warnings: AgentIssue[];
  yaml: string | null;
};

export type AgentSessionDetail = {
  session: AgentSession;
  messages: AgentMessage[];
  turns: AgentTurn[];
  /** Every recorded span, ordered by turn then start time. Empty when capture is off. */
  spans: AgentSpan[];
  approvals: AgentApproval[];
  pendingApproval: AgentApproval | null;
  evalScores: AgentEvalScore[];
  /** Channel replies and how they went, one per turn that had to reach someone. */
  deliveries: AgentDelivery[];
};

export type ActiveTurn = {
  session: AgentSession;
  definition: AgentDefinition;
  turn: AgentTurn;
  history: AgentMessage[];
  userMessage: AgentMessage;
};

export type ChangeActor = { source: RevisionSource; author?: string | null };

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function sameDefinition(left: AgentDefinition, right: AgentDefinition): boolean {
  return serializeAgentDefinition(left) === serializeAgentDefinition(right);
}

export class AgentService {
  private readonly store: AgentStore;
  private readonly environment: AgentEnvironment;
  private readonly now: () => Date;
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Wakes a turn paused at an ask-first tool when its approval is decided. */
  readonly approvalBroker = new ApprovalBroker();
  /** Owns every legal change of a turn, its session and its approval. */
  private readonly lifecycle: TurnLifecycle;
  /** Reply delivery bookkeeping, for ReplyDelivery. */
  readonly deliveries: DeliveryLedger;
  /** Next-run bookkeeping, for the scheduler. */
  readonly schedules: ScheduleLedger;

  constructor(options: { store: AgentStore; environment?: AgentEnvironment; now?: () => Date; /** How long a file must be unchanged before its stamp is trusted (default 2 s). */ treeTrustMs?: number }) {
    this.store = options.store;
    this.treeTrustMs = options.treeTrustMs ?? 2_000;
    this.environment = options.environment ?? NO_ENVIRONMENT;
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new TurnLifecycle(this.store, this.approvalBroker, () => this.iso());
    this.deliveries = deliveryLedger(this.store, () => this.iso());
    this.schedules = scheduleLedger(this.store);
  }

  /** The service clock, so waits and expiries agree with stored timestamps. */
  clockMs(): number {
    return this.now().getTime();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  /** Serialize file-and-database work per project so a save and a sync never interleave. */
  private exclusive<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectRoot);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private dir(projectRoot: string): string {
    return path.join(projectRoot, "agents");
  }

  private file(projectRoot: string, agentId: string): string {
    return path.join(this.dir(projectRoot), `${agentId}.agent.yaml`);
  }

  /* ---------- file sync ---------- */

  /**
   * What the agents directory looked like at the last full sync, per project: names, sizes and modification times.
   * While it is unchanged (and old enough to trust), a sync is one readdir and one stat per file, with no reads or
   * hashing. Cleared by our own writes and archives.
   */
  private readonly syncedTree = new Map<string, string>();

  /** A file touched this recently may be edited again within the clock's resolution, so its stamp is not trusted yet. */
  private readonly treeTrustMs: number;

  private async treeStamp(projectRoot: string): Promise<{ stamp: string; trusted: boolean }> {
    let names: string[];
    try {
      names = await readdir(this.dir(projectRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { stamp: "", trusted: true };
    }
    const parts: string[] = [];
    let newest = 0;
    for (const name of names.sort()) {
      if (!name.endsWith(".agent.yaml")) continue;
      try {
        const info = await stat(path.join(this.dir(projectRoot), name));
        newest = Math.max(newest, info.mtimeMs, info.ctimeMs);
        parts.push(`${name}:${info.size}:${info.mtimeMs}:${info.ino}`);
      } catch {
        parts.push(`${name}:gone`);
      }
    }
    return { stamp: parts.join("|"), trusted: Date.now() - Math.floor(newest) >= this.treeTrustMs };
  }

  /**
   * Bring the database in line with `agents/*.agent.yaml`. Only files whose
   * content hash changed are parsed. An unchanged tree costs a readdir and a
   * stat per file, and writes nothing; a changed or freshly touched one is
   * read and hashed in full.
   */
  private async sync(projectRoot: string): Promise<void> {
    const key = path.resolve(projectRoot);
    const before = await this.treeStamp(projectRoot);
    if (before.trusted && this.syncedTree.get(key) === before.stamp) return;
    this.syncedTree.delete(key);
    await this.fullSync(projectRoot);
    // The stamp from before the sync: an edit that landed meanwhile differs from it and is picked up next time.
    if (before.trusted) this.syncedTree.set(key, before.stamp);
  }

  private async fullSync(projectRoot: string): Promise<void> {
    const projectKey = agentProjectKey(projectRoot);
    let names: string[];
    try {
      names = await readdir(this.dir(projectRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names.sort()) {
      if (!name.endsWith(".agent.yaml")) continue;
      const agentId = name.slice(0, -".agent.yaml".length);
      seen.add(agentId);
      const text = await readFile(path.join(this.dir(projectRoot), name), "utf8");
      const fileHash = sha256(text);
      const row = this.store.getDefinition(projectKey, agentId);
      if (row && row.fileHash === fileHash && !row.archived) continue;
      this.applyFile(projectKey, agentId, text, fileHash, row);
    }
    for (const row of this.store.listDefinitions(projectKey)) {
      if (!seen.has(row.agentId) && !row.archived) {
        this.store.updateDefinitionState(projectKey, row.agentId, { archived: true, fileHash: null }, this.iso());
      }
    }
  }

  private applyFile(
    projectKey: string,
    agentId: string,
    text: string,
    fileHash: string,
    row: AgentDefinitionRow | undefined,
  ): void {
    const now = this.iso();
    const parsed = parseAgentYaml(text);
    const issues: AgentIssue[] = !parsed.ok
      ? parsed.issues
      : parsed.value.id !== agentId
        ? [{ path: "id", code: "agent.id_mismatch", message: `id must match the file name (${agentId})` }]
        : [];
    if (!parsed.ok || issues.length > 0) {
      if (!row || row.currentRevision === 0) {
        this.store.recordInvalidNewDefinition(projectKey, agentId, fileHash, issues, now);
      } else {
        this.store.updateDefinitionState(projectKey, agentId, { fileHash, issues, archived: false }, now);
      }
      return;
    }
    const current = row && row.currentRevision > 0 ? this.store.getRevision(projectKey, agentId, row.currentRevision) : undefined;
    if (current && sameDefinition(current.definition, parsed.value)) {
      this.store.updateDefinitionState(projectKey, agentId, { fileHash, issues: [], archived: false }, now);
      return;
    }
    this.store.appendRevision(projectKey, {
      definition: parsed.value,
      yaml: text,
      source: "file",
      summary: current ? "Edited outside the console" : "Added outside the console",
      fileHash,
      now,
    });
  }

  /** Write the canonical YAML and record the revision in one step. */
  private async writeRevision(
    projectRoot: string,
    definition: AgentDefinition,
    actor: ChangeActor,
    summary: string | null,
    restoredFrom: number | null = null,
  ): Promise<number> {
    const yaml = serializeAgentDefinition(definition);
    await mkdir(this.dir(projectRoot), { recursive: true });
    const target = this.file(projectRoot, definition.id);
    const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, yaml);
    await rename(temporary, target);
    this.syncedTree.delete(path.resolve(projectRoot));
    const revision = this.store.appendRevision(agentProjectKey(projectRoot), {
      definition,
      yaml,
      source: actor.source,
      author: actor.author ?? null,
      summary,
      restoredFrom,
      fileHash: sha256(yaml),
      now: this.iso(),
    });
    this.notifyChanged();
    return revision;
  }

  private readonly changeListeners: Array<() => void> = [];

  /** Called after an agent is saved, enabled, disabled, restored or archived, so listeners on channels can follow. */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // a listener must never break a save
      }
    }
  }

  private currentRevision(projectRoot: string, agentId: string): { row: AgentDefinitionRow; revision: AgentRevision } {
    const projectKey = agentProjectKey(projectRoot);
    const row = this.store.getDefinition(projectKey, agentId);
    if (!row || row.currentRevision === 0) throw new AgentError("agent.not_found");
    if (row.archived) throw new AgentError("agent.archived");
    const revision = this.store.getRevision(projectKey, agentId, row.currentRevision);
    if (!revision) throw new AgentError("agent.revision_not_found");
    return { row, revision };
  }

  /* ---------- reads ---------- */

  private summarize(projectKey: string, row: AgentDefinitionRow, pending: Map<string, number>): AgentSummary {
    const revision = row.currentRevision > 0 ? this.store.getRevision(projectKey, row.agentId, row.currentRevision) : undefined;
    const definition = revision?.definition;
    const since = new Date(this.now().getTime() - RECENT_WINDOW_MS).toISOString();
    return {
      id: row.agentId,
      name: definition?.name ?? row.agentId,
      description: definition?.description ?? null,
      enabled: definition?.enabled ?? false,
      revision: row.currentRevision,
      issues: row.issues,
      model: definition?.model ?? null,
      tools: {
        builtin: definition?.tools.builtin ?? [],
        builtinTools: definition?.tools.builtin_tools ?? [],
        mcpServers: Object.keys(definition?.tools.mcp ?? {}),
        skills: definition?.tools.skills ?? [],
        browser: definition?.tools.browser ?? false,
      },
      askFirst: definition ? effectiveAskFirst(definition) : [],
      channelConnection: definition?.channel?.connection_id ?? null,
      scheduleCron: definition?.schedule?.cron ?? null,
      subAgents: definition?.sub_agents ?? [],
      capture: definition?.observability.capture ?? null,
      webChatUrl: definition?.web_chat.enabled && definition.web_chat.slug ? `/chat/${definition.web_chat.slug}` : null,
      stats: this.store.sessionStats(projectKey, row.agentId, since),
      pendingApprovals: pending.get(row.agentId) ?? 0,
      updatedAt: row.updatedAt,
    };
  }

  private pendingByAgent(projectKey: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const approval of this.store.listPendingApprovals(projectKey)) {
      counts.set(approval.agentId, (counts.get(approval.agentId) ?? 0) + 1);
    }
    return counts;
  }

  async list(projectRoot: string): Promise<AgentSummary[]> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      this.expireApprovals();
      const pending = this.pendingByAgent(projectKey);
      return this.store
        .listDefinitions(projectKey)
        .filter((row) => !row.archived)
        .map((row) => this.summarize(projectKey, row, pending));
    });
  }

  async get(projectRoot: string, agentId: string): Promise<AgentDetail> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      const row = this.store.getDefinition(projectKey, agentId);
      if (!row) throw new AgentError("agent.not_found");
      const revision = row.currentRevision > 0 ? this.store.getRevision(projectKey, agentId, row.currentRevision) : undefined;
      return {
        agent: this.summarize(projectKey, row, this.pendingByAgent(projectKey)),
        definition: revision?.definition ?? null,
        yaml: revision?.yaml ?? null,
        warnings: revision ? await this.warningsFor(projectRoot, revision.definition) : [],
      };
    });
  }

  /** The definition a session is pinned to. */
  async definitionAt(projectRoot: string, agentId: string, revision: number): Promise<AgentDefinition> {
    const found = this.store.getRevision(agentProjectKey(projectRoot), agentId, revision);
    if (!found) throw new AgentError("agent.revision_not_found");
    return found.definition;
  }

  /* ---------- validation ---------- */

  private async warningsFor(projectRoot: string, definition: AgentDefinition): Promise<AgentIssue[]> {
    const warnings: AgentIssue[] = [];
    if (definition.web_chat.enabled && !definition.web_chat.slug) {
      warnings.push({ path: "web_chat.slug", code: "agent.web_chat_slug_missing", message: "Web chat has no link yet; save the agent in the console to generate one" });
    }
    if (definition.web_chat.enabled) {
      const readsChats = grantedStageflowTools(definition.tools.stageflow).filter((tool) => CONVERSATION_READING_TOOLS.has(tool));
      if (readsChats.length > 0) {
        warnings.push({
          path: "tools.stageflow",
          code: "agent.web_chat_reads_conversations",
          message: `Web chat is on and this agent can read every agent's sessions (${readsChats.join(", ")}), including what customers wrote`,
        });
      }
    }
    if (grantedBuiltinTools(definition).includes("bash")) {
      warnings.push({
        path: "tools.builtin",
        code: "agent.shell_not_path_confined",
        message: "Shell access is not path-confined: this agent can change agent definitions and Stageflow state through bash even though file tools are blocked from them. Every shell command waits for approval",
      });
    }
    if (definition.model.backend === "claude") {
      warnings.push({ path: "model.backend", code: "agent.backend_unavailable", message: "Agents run on Pi today; sessions on the claude backend fail" });
    }
    if (definition.execution === "sandbox") {
      warnings.push({ path: "execution", code: "agent.sandbox_unavailable", message: "No sandbox runner is installed; sessions on this agent fail" });
    }
    if (definition.model.id) {
      const info = await this.environment.modelInfo?.(definition.model.id);
      if (info && !info.known) {
        warnings.push({ path: "model.id", code: "agent.model_unknown", message: `${definition.model.id} is not listed by a connected provider; it will still be tried` });
      } else if (info?.nativeTools) {
        warnings.push({ path: "model.id", code: "agent.model_native_tools", message: "This provider runs its own file and shell tools, so grants and approvals cannot hold; sessions fail unless the Host opts in" });
      }
    }
    const servers = Object.keys(definition.tools.mcp);
    if (servers.length > 0) {
      const known = await this.environment.mcpServerNames(projectRoot);
      for (const server of servers) {
        if (known && !known.includes(server)) {
          warnings.push({
            path: `tools.mcp.${server}`,
            code: "agent.mcp_server_unknown",
            message: `${server} is not in the project .mcp.json or the servers saved from the console`,
          });
        }
      }
    }
    if (definition.tools.skills.length > 0) {
      const known = await this.environment.skillNames(projectRoot);
      definition.tools.skills.forEach((skill, index) => {
        if (known && !known.includes(skill)) {
          warnings.push({ path: `tools.skills.${index}`, code: "agent.skill_unknown", message: `Skill ${skill} not found` });
        }
      });
    }
    if (definition.sub_agents.length > 0) {
      const projectKey = agentProjectKey(projectRoot);
      definition.sub_agents.forEach((agentId, index) => {
        const row = this.store.getDefinition(projectKey, agentId);
        if (!row || row.archived || row.currentRevision === 0) {
          warnings.push({ path: `sub_agents.${index}`, code: "agent.sub_agent_unknown", message: `No agent named ${agentId}` });
        }
      });
    }
    if (definition.channel) {
      const known = await this.environment.connectionIds();
      if (known && !known.includes(definition.channel.connection_id)) {
        warnings.push({ path: "channel.connection_id", code: "agent.connection_unknown", message: `Connection ${definition.channel.connection_id} not found` });
      }
      if (definition.channel.allow_from.length === 0) {
        warnings.push({ path: "channel.allow_from", code: "agent.channel_nobody_allowed", message: "Nobody is allowed to message this agent yet. Add the people or domains it should answer." });
      } else if (definition.channel.allow_from.includes("*")) {
        warnings.push({ path: "channel.allow_from", code: "agent.channel_open_to_anyone", message: "Anyone who can reach this connection can talk to this agent" });
      }
    }
    if (definition.approvals.approvers.channel_ids.length > 0) {
      warnings.push({
        path: "approvals.approvers.channel_ids",
        code: "agent.channel_approvers_unused",
        message: "Approving from a chat channel is not supported yet; these ids are ignored and approvals are decided in the console",
      });
    }
    return warnings;
  }

  /**
   * Web chat defaults and links: a new agent starts with web chat on, an enabled block without a link
   * gets one, and `slug: ""` asks for a new link (rotate). Previews never mint links.
   */
  private prepareWebChat(raw: unknown, mode: "create" | "save" | "preview"): unknown {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const input = { ...(raw as Record<string, unknown>) };
    let block = input.web_chat;
    if (block === undefined && mode === "create") block = { enabled: true };
    if (typeof block !== "object" || block === null || Array.isArray(block)) return mode === "create" ? { ...input, web_chat: block } : raw;
    const webChat = { ...(block as Record<string, unknown>) };
    const wantsLink = webChat.enabled === true && (webChat.slug === undefined || webChat.slug === "");
    if (webChat.slug === "") delete webChat.slug;
    if (wantsLink && mode !== "preview") webChat.slug = newWebChatSlug();
    return { ...input, web_chat: webChat };
  }

  /** The enabled agent a public link points at, or null. */
  async findWebChatAgent(projectRoot: string, slug: string): Promise<{ agentId: string; definition: AgentDefinition } | null> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      for (const row of this.store.listDefinitions(projectKey)) {
        if (row.archived || row.currentRevision === 0) continue;
        const definition = this.store.getRevision(projectKey, row.agentId, row.currentRevision)?.definition;
        if (definition?.enabled && definition.web_chat.enabled && definition.web_chat.slug === slug) {
          return { agentId: row.agentId, definition };
        }
      }
      return null;
    });
  }

  /** Fills a missing id from the agent's name so callers never have to choose one. */
  private async withGeneratedId(projectRoot: string, raw: unknown): Promise<unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const input = raw as Record<string, unknown>;
    if (typeof input.id === "string" && input.id.length > 0) return raw;
    if (typeof input.name !== "string" || input.name.trim().length === 0) return raw;
    const projectKey = agentProjectKey(projectRoot);
    const id = await generateAgentId(input.name, async (candidate) => {
      if (this.store.getDefinition(projectKey, candidate)) return true;
      return access(this.file(projectRoot, candidate)).then(
        () => true,
        () => false,
      );
    });
    return { ...input, id };
  }

  /** One connection answers for one agent: another agent already on this connection is an error. */
  private async channelConflicts(projectRoot: string, definition: AgentDefinition): Promise<AgentIssue[]> {
    const connectionId = definition.channel?.connection_id;
    if (!connectionId) return [];
    const projectKey = agentProjectKey(projectRoot);
    const identityOf = async (id: string) => (await this.environment.connectionIdentity?.(id).catch(() => undefined)) ?? `connection:${id}`;
    const mine = await identityOf(connectionId);
    const others = this.store
      .listDefinitions(projectKey)
      .filter((row) => !row.archived && row.currentRevision > 0 && row.agentId !== definition.id)
      .map((row) => ({ agentId: row.agentId, connection: this.store.getRevision(projectKey, row.agentId, row.currentRevision)?.definition.channel?.connection_id }));
    for (const other of others) {
      if (!other.connection) continue;
      if (other.connection === connectionId) {
        return [{ path: "channel.connection_id", code: "agent.channel_in_use", message: `${connectionId} already answers for the agent ${other.agentId}. An agent has one channel and a connection has one agent.` }];
      }
      if ((await identityOf(other.connection)) === mine) {
        return [{ path: "channel.connection_id", code: "agent.channel_in_use", message: `${connectionId} reaches the same inbox or line as ${other.connection}, which ${other.agentId} already answers. One inbox has one agent.` }];
      }
    }
    return [];
  }

  async validate(projectRoot: string, rawInput: unknown): Promise<ValidationResult> {
    const raw = this.prepareWebChat(await this.withGeneratedId(projectRoot, rawInput), "preview");
    const parsed = parseAgentDefinition(raw);
    if (!parsed.ok) return { definition: null, issues: parsed.issues, warnings: [], yaml: null };
    const conflicts = await this.channelConflicts(projectRoot, parsed.value);
    if (conflicts.length > 0) return { definition: null, issues: conflicts, warnings: [], yaml: null };
    return {
      definition: parsed.value,
      issues: [],
      warnings: await this.warningsFor(projectRoot, parsed.value),
      yaml: serializeAgentDefinition(parsed.value),
    };
  }

  private parseOrThrow(raw: unknown): AgentDefinition {
    const parsed = parseAgentDefinition(raw);
    if (!parsed.ok) throw new AgentError("agent.invalid", "Agent definition is invalid", parsed.issues);
    return parsed.value;
  }

  /* ---------- writes ---------- */

  async create(projectRoot: string, rawInput: unknown, actor: ChangeActor): Promise<AgentDetail> {
    const definition = this.parseOrThrow(this.prepareWebChat(await this.withGeneratedId(projectRoot, rawInput), "create"));
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const conflicts = await this.channelConflicts(projectRoot, definition);
      if (conflicts.length > 0) throw new AgentError("agent.invalid", "Agent definition is invalid", conflicts);
      const existing = this.store.getDefinition(agentProjectKey(projectRoot), definition.id);
      const onDisk = await access(this.file(projectRoot, definition.id)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (onDisk || (existing && !existing.archived)) throw new AgentError("agent.exists");
      // A new agent always starts disabled (R1); enabling is its own revision.
      await this.writeRevision(projectRoot, { ...definition, enabled: false }, actor, "Created");
    });
    return this.get(projectRoot, definition.id);
  }

  async save(
    projectRoot: string,
    agentId: string,
    input: { baseRevision: number; definition: unknown; summary?: string | null },
    actor: ChangeActor,
  ): Promise<AgentDetail> {
    // A client that leaves `web_chat` out (CLI, MCP, scripts) keeps the agent's current link and limits.
    let incoming = input.definition;
    if (typeof incoming === "object" && incoming !== null && !Array.isArray(incoming) && (incoming as Record<string, unknown>).web_chat === undefined) {
      const projectKey = agentProjectKey(projectRoot);
      const row = this.store.getDefinition(projectKey, agentId);
      const current = row && row.currentRevision > 0 ? this.store.getRevision(projectKey, agentId, row.currentRevision)?.definition : undefined;
      if (current) incoming = { ...(incoming as Record<string, unknown>), web_chat: current.web_chat };
    }
    const definition = this.parseOrThrow(this.prepareWebChat(incoming, "save"));
    if (definition.id !== agentId) {
      throw new AgentError("agent.invalid", "The id cannot change", [
        { path: "id", code: "agent.id_immutable", message: "The id is fixed after creation" },
      ]);
    }
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const { row, revision } = this.currentRevision(projectRoot, agentId);
      if (row.currentRevision !== input.baseRevision) throw new AgentError("agent.conflict");
      const conflicts = await this.channelConflicts(projectRoot, definition);
      if (conflicts.length > 0) throw new AgentError("agent.invalid", "Agent definition is invalid", conflicts);
      if (sameDefinition(revision.definition, definition)) return;
      await this.writeRevision(projectRoot, definition, actor, input.summary?.trim() || null);
    });
    return this.get(projectRoot, agentId);
  }

  async setEnabled(projectRoot: string, agentId: string, enabled: boolean, actor: ChangeActor): Promise<AgentDetail> {
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const { row, revision } = this.currentRevision(projectRoot, agentId);
      if (row.issues.length > 0 && enabled) {
        throw new AgentError("agent.invalid", "Fix the agent file before enabling it", row.issues);
      }
      if (revision.definition.enabled === enabled) return;
      await this.writeRevision(projectRoot, { ...revision.definition, enabled }, actor, enabled ? "Enabled" : "Disabled");
    });
    return this.get(projectRoot, agentId);
  }

  private readonly archiveListeners: Array<(agentId: string, sessionIds: string[]) => void> = [];

  /** Called after an agent is archived with the ids of its sessions, so a runtime can let go of what it holds for them. */
  onArchived(listener: (agentId: string, sessionIds: string[]) => void): void {
    this.archiveListeners.push(listener);
  }

  /** Remove the file; history stays readable (R5). */
  async archive(projectRoot: string, agentId: string): Promise<void> {
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const row = this.store.getDefinition(agentProjectKey(projectRoot), agentId);
      if (!row || row.archived) throw new AgentError("agent.not_found");
      this.syncedTree.delete(path.resolve(projectRoot));
      await rm(this.file(projectRoot, agentId), { force: true });
      this.store.updateDefinitionState(agentProjectKey(projectRoot), agentId, { archived: true, fileHash: null }, this.iso());
    });
    const sessionIds = this.store.sessionIdsOf(agentProjectKey(projectRoot), agentId);
    for (const listener of this.archiveListeners) {
      try {
        listener(agentId, sessionIds);
      } catch {
        // a listener must never break an archive
      }
    }
    this.notifyChanged();
  }

  /* ---------- revisions ---------- */

  async listRevisions(projectRoot: string, agentId: string): Promise<AgentRevisionMeta[]> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      if (!this.store.getDefinition(projectKey, agentId)) throw new AgentError("agent.not_found");
      return this.store.listRevisions(projectKey, agentId);
    });
  }

  async getRevision(projectRoot: string, agentId: string, revision: number): Promise<AgentRevision> {
    const found = this.store.getRevision(agentProjectKey(projectRoot), agentId, revision);
    if (!found) throw new AgentError("agent.revision_not_found");
    return found;
  }

  async diffRevisions(projectRoot: string, agentId: string, from: number, to: number): Promise<DiffLine[]> {
    const [before, after] = await Promise.all([
      this.getRevision(projectRoot, agentId, from),
      this.getRevision(projectRoot, agentId, to),
    ]);
    return diffLines(before.yaml, after.yaml);
  }

  /** Re-save an old revision as the newest one. Enabled state stays as it is now. */
  async restore(
    projectRoot: string,
    agentId: string,
    input: { revision: number; baseRevision: number },
    actor: ChangeActor,
  ): Promise<AgentDetail> {
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const { row, revision: current } = this.currentRevision(projectRoot, agentId);
      if (row.currentRevision !== input.baseRevision) throw new AgentError("agent.conflict");
      const target = this.store.getRevision(agentProjectKey(projectRoot), agentId, input.revision);
      if (!target) throw new AgentError("agent.revision_not_found");
      const definition = { ...target.definition, enabled: current.definition.enabled };
      if (sameDefinition(definition, current.definition)) return;
      await this.writeRevision(
        projectRoot,
        definition,
        { ...actor, source: "restore" },
        `Restored v${input.revision}`,
        input.revision,
      );
    });
    return this.get(projectRoot, agentId);
  }

  /* ---------- sessions ---------- */

  async openSession(
    projectRoot: string,
    agentId: string,
    input: { source: string; sourceRef?: string | null; threadKey?: string | null; title?: string | null },
  ): Promise<AgentSession> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const { revision } = this.currentRevision(projectRoot, agentId);
      if (!revision.definition.enabled) throw new AgentError("agent.disabled");
      const now = this.iso();
      const session: AgentSession = {
        id: id("ses"),
        agentId,
        revision: revision.revision,
        backend: revision.definition.model.backend,
        status: "open",
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        threadKey: input.threadKey ?? null,
        title: input.title ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.insertSession(agentProjectKey(projectRoot), session);
      return session;
    });
  }

  /** Id of the session's pending approval, if a turn is waiting on a person. */
  pendingApprovalFor(_projectRoot: string, sessionId: string): string | null {
    return this.store.listApprovals(sessionId).find((approval) => approval.status === "pending")?.id ?? null;
  }

  listSessionsForRef(projectRoot: string, agentId: string, source: string, sourceRef: string, limit: number): AgentSession[] {
    return this.store.listSessionsForRef(agentProjectKey(projectRoot), agentId, source, sourceRef, limit);
  }

  private sessionInProject(projectRoot: string, sessionId: string): AgentSession {
    const session = this.store.getSession(sessionId);
    if (!session || session.projectKey !== agentProjectKey(projectRoot)) {
      throw new AgentError("agent.session_not_found");
    }
    return session;
  }

  async getSession(projectRoot: string, sessionId: string): Promise<AgentSessionDetail> {
    this.expireApprovals();
    const session = this.sessionInProject(projectRoot, sessionId);
    const approvals = this.store.listApprovals(sessionId);
    return {
      session: this.store.getSession(sessionId)!,
      messages: this.store.listMessages(sessionId),
      turns: this.store.listTurns(sessionId),
      spans: this.store.listSpansForSession(sessionId),
      approvals,
      pendingApproval: approvals.find((approval) => approval.status === "pending") ?? null,
      evalScores: this.store.listEvalScores(session.id),
      deliveries: this.store.listDeliveries(sessionId),
    };
  }

  async listSessions(
    projectRoot: string,
    agentId: string,
    query: SessionQuery,
  ): Promise<{ sessions: AgentSessionListItem[]; nextCursor: string | null; stats: SessionStats }> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      if (!this.store.getDefinition(projectKey, agentId)) throw new AgentError("agent.not_found");
      this.expireApprovals();
      const since = new Date(this.now().getTime() - RECENT_WINDOW_MS).toISOString();
      return {
        ...this.store.listSessions(projectKey, agentId, query),
        stats: this.store.sessionStats(projectKey, agentId, since),
      };
    });
  }

  /** Sessions of every agent in the project (or of one, when `agentId` is given), newest first, with matching stats. */
  async listAllSessions(
    projectRoot: string,
    query: SessionQuery,
    agentId?: string,
  ): Promise<{ sessions: AgentSessionListItem[]; nextCursor: string | null; stats: SessionStats }> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      this.expireApprovals();
      const since = new Date(this.now().getTime() - RECENT_WINDOW_MS).toISOString();
      return {
        ...this.store.listSessions(projectKey, agentId, query),
        stats: this.store.sessionStats(projectKey, agentId, since),
      };
    });
  }

  listSpans(projectRoot: string, sessionId: string): AgentSpan[] {
    this.sessionInProject(projectRoot, sessionId);
    return this.store.listSpansForSession(sessionId);
  }

  /** OTLP/JSON for every turn of a session (what "Export session traces" downloads). */
  exportSessionOtlp(projectRoot: string, sessionId: string): Record<string, unknown> {
    const session = this.sessionInProject(projectRoot, sessionId);
    const spans = this.store.listSpansForSession(sessionId);
    return exportTurnsToOtlp(
      this.store.listTurns(sessionId).map((turn) => ({ turn, spans: spans.filter((span) => span.turnId === turn.id) })),
      { serviceName: "stageflow-agent-runtime", agentId: session.agentId },
    );
  }

  /** OTLP/JSON for one finished turn, for live export to a collector. */
  exportTurnOtlp(projectRoot: string, turnId: string): Record<string, unknown> {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new AgentError("agent.session_not_found");
    const session = this.sessionInProject(projectRoot, turn.sessionId);
    const spans = this.store.listSpansForSession(session.id).filter((span) => span.turnId === turnId);
    return exportTurnsToOtlp([{ turn, spans }], { serviceName: "stageflow-agent-runtime", agentId: session.agentId });
  }

  /* ---------- turns ---------- */

  /**
   * Start a turn on a session's pinned revision: records the user message and
   * marks the session running. The live agent state (enabled, not archived)
   * gates new turns; the pinned revision supplies the configuration.
   */
  async beginTurn(
    projectRoot: string,
    sessionId: string,
    input: { text: string; author?: string | null; resumeTurnId?: string },
  ): Promise<ActiveTurn> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const session = this.sessionInProject(projectRoot, sessionId);
      const { revision: live } = this.currentRevision(projectRoot, session.agentId);
      if (!live.definition.enabled) throw new AgentError("agent.disabled");
      if (session.status === "running" || session.status === "waiting") throw new AgentError("agent.session_busy");
      const definition = await this.definitionAt(projectRoot, session.agentId, session.revision);
      this.assertWithinLimits(definition, session);
      const now = this.iso();
      return this.store.transaction(() => {
        // A retry takes over the earlier turn's unanswered message instead of adding it a second time.
        const retried = input.resumeTurnId ? this.store.listMessages(sessionId).find((m) => m.turnId === input.resumeTurnId && m.role === "user") : undefined;
        const history = this.store.listMessages(sessionId).filter((m) => m.id !== retried?.id);
        const turn = this.store.insertTurn({
          id: id("turn"),
          sessionId,
          revision: session.revision,
          traceId: randomBytes(16).toString("hex"),
          status: "running",
          errorCode: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          startedAt: now,
          endedAt: null,
        });
        let userMessage: AgentMessage;
        if (retried) {
          this.store.moveMessageToTurn(retried.id, turn.id);
          userMessage = { ...retried, turnId: turn.id };
        } else {
          userMessage = this.store.appendMessage({
            id: id("msg"),
            sessionId,
            turnId: turn.id,
            role: "user",
            author: input.author ?? null,
            text: input.text,
            createdAt: now,
          });
        }
        this.store.updateSession(
          sessionId,
          { status: "running", ...(session.title ? {} : { title: titleFrom(input.text) }) },
          now,
        );
        return { session: this.store.getSession(sessionId)!, definition, turn, history, userMessage };
      });
    });
  }

  /** Session limits (`limits` in the pinned revision) are checked before each new turn. */
  private assertWithinLimits(definition: AgentDefinition, session: AgentSession): void {
    const { limits } = definition;
    const turns = this.store.listTurns(session.id);
    if (!limits.always_on) {
      if (turns.length >= limits.max_turns) {
        throw new AgentError("agent.limit_reached", `This session reached its limit of ${limits.max_turns} turns.`);
      }
      const ageMinutes = (this.now().getTime() - Date.parse(session.createdAt)) / 60_000;
      if (ageMinutes >= limits.session_minutes) {
        throw new AgentError("agent.limit_reached", `This session reached its limit of ${limits.session_minutes} minutes.`);
      }
    }
    if (limits.cost_usd !== null) {
      // An always-on session has no end, so its cap is per day instead of per session.
      const since = limits.always_on ? this.now().getTime() - 24 * 60 * 60_000 : 0;
      const spent = turns.filter((turn) => Date.parse(turn.startedAt) >= since).reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
      if (spent >= limits.cost_usd) {
        throw new AgentError("agent.limit_reached", `This session reached its cost limit of $${limits.cost_usd}${limits.always_on ? " for today" : ""}.`);
      }
    }
  }

  /**
   * A turn is about to pause for a person. Returns "waiting" once it is parked, or the approval's outcome when it was
   * already decided in between (nothing to wait for), or "inactive" when the turn is no longer running.
   */
  async waitOnApproval(projectRoot: string, turnId: string, approvalId: string): Promise<"waiting" | "approved" | "denied" | "expired" | "inactive"> {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new AgentError("agent.session_not_found");
    this.sessionInProject(projectRoot, turn.sessionId);
    return this.exclusive(projectRoot, async () => this.lifecycle.wait(turnId, approvalId));
  }

  /** The wait is over (decided, expired): the turn runs again. */
  async resumeTurn(projectRoot: string, turnId: string): Promise<void> {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new AgentError("agent.session_not_found");
    this.sessionInProject(projectRoot, turn.sessionId);
    await this.exclusive(projectRoot, async () => {
      this.lifecycle.resume(turnId);
    });
  }

  /** A stopped turn leaves its ask-first approval behind; close it so it cannot be approved later. */
  async closeApproval(projectRoot: string, approvalId: string): Promise<void> {
    await this.exclusive(projectRoot, async () => {
      const approval = this.store.getApproval(approvalId);
      if (!approval) return;
      this.sessionInProject(projectRoot, approval.sessionId);
      this.lifecycle.closeApproval(approvalId);
      const session = this.store.getSession(approval.sessionId);
      if (session?.status === "waiting") this.store.updateSession(session.id, { status: "open" }, this.iso());
    });
  }

  /**
   * End a turn. Guarded: a turn that is already over is left as it is (the session detail is returned unchanged), so a
   * late failure handler cannot rewrite a finished outcome.
   */
  async completeTurn(
    projectRoot: string,
    turnId: string,
    input: {
      status: FinishInput["status"];
      assistantText?: string;
      errorCode?: string | null;
      usage?: { inputTokens?: number; outputTokens?: number };
      costUsd?: number | null;
      evalScores?: Array<{ metric: string; score: number }>;
      sessionStatus?: SessionStatus;
    },
  ): Promise<AgentSessionDetail> {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new AgentError("agent.session_not_found");
    const session = this.sessionInProject(projectRoot, turn.sessionId);
    await this.exclusive(projectRoot, async () => {
      this.lifecycle.finish(turnId, {
        status: input.status,
        errorCode: input.errorCode ?? null,
        ...(input.assistantText ? { assistant: { id: id("msg"), author: session.agentId, text: input.assistantText } } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
        ...(input.evalScores ? { evalScores: input.evalScores } : {}),
        ...(input.sessionStatus ? { sessionStatus: input.sessionStatus } : {}),
      });
    });
    return this.getSession(projectRoot, session.id);
  }

  recordSpan(projectRoot: string, span: AgentSpan): void {
    const turn = this.store.getTurn(span.turnId);
    if (!turn) throw new AgentError("agent.session_not_found");
    this.sessionInProject(projectRoot, turn.sessionId);
    this.store.insertSpan(span);
  }

  /** Called at host start: turns that were running when the host stopped can't resume. */
  private interrupted: string[] = [];

  recoverInterruptedTurns(): number {
    this.interrupted = this.store.interruptedTurnIds();
    return this.lifecycle.interruptedByRestart();
  }

  /**
   * Turns a restart cut off on an always-on agent, on a channel where a reply goes back to the sender's own handle
   * (iMessage). Each is retried once; the person's message is not asked again.
   */
  async resumableTurns(projectRoot: string): Promise<Array<{ agentId: string; sessionId: string; turnId: string; text: string; from: string; connectionId: string; provider: string; threadId: string }>> {
    const resumable = [];
    for (const turnId of this.interrupted.splice(0)) {
      const turn = this.store.getTurn(turnId);
      if (!turn) continue;
      const session = this.store.getSession(turn.sessionId);
      if (!session || session.source !== "imessage" || !session.sourceRef || !session.threadKey) continue;
      const definition = await this.definitionAt(projectRoot, session.agentId, session.revision).catch(() => undefined);
      if (!definition?.limits.always_on || !definition.enabled) continue;
      const messages = this.store.listMessages(session.id).filter((m) => m.turnId === turnId);
      const user = messages.find((m) => m.role === "user");
      if (!user || messages.some((m) => m.role === "assistant")) continue;
      const [, connectionId = "", threadId = ""] = session.threadKey.split("\0");
      resumable.push({ agentId: session.agentId, sessionId: session.id, turnId, text: user.text, from: session.sourceRef, connectionId, provider: session.source, threadId });
    }
    return resumable;
  }

  /* ---------- channel deliveries ---------- */

  /** Sends a restart cut off may or may not have arrived; they wait for a person. */
  settleInterruptedDeliveries(): string[] {
    const ids = this.store.settleInterruptedDeliveries(this.iso());
    this.lifecycle.replyUnconfirmed(ids);
    return ids;
  }

  /** A reply that did not get through makes its turn a failure; one that finally does puts it right. */
  setReplyDelivered(turnId: string, delivered: boolean): void {
    this.lifecycle.replyDelivery(turnId, delivered);
  }

  latestUndelivered(projectRoot: string, agentId: string): AgentDelivery | undefined {
    return this.store.latestUndelivered(agentId, agentProjectKey(projectRoot));
  }

  /* ---------- approvals ---------- */

  private expireApprovals(): void {
    this.lifecycle.expireDue();
  }

  async requestApproval(
    projectRoot: string,
    sessionId: string,
    input: { tool: string; payload: Record<string, unknown>; turnId?: string | null },
  ): Promise<AgentApproval> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      this.expireApprovals();
      const session = this.sessionInProject(projectRoot, sessionId);
      const { revision: live } = this.currentRevision(projectRoot, session.agentId);
      if (!live.definition.enabled) throw new AgentError("agent.disabled");
      const definition = await this.definitionAt(projectRoot, session.agentId, session.revision);
      if (!isToolGranted(definition, input.tool)) throw new AgentError("agent.tool_not_granted");
      if (!requiresAskFirst(definition, input.tool)) throw new AgentError("agent.approval_not_required");
      const payloadHash = hashApprovalPayload(input.payload);
      if (this.store.hasExecutedPayload(sessionId, payloadHash)) {
        const prior = this.store.findApprovalByPayload(sessionId, payloadHash);
        if (prior) return prior;
      }
      const existing = this.store.getPendingApproval(sessionId);
      if (existing) {
        // One pending approval per session, and it only stands for the exact call it was raised for.
        if (existing.tool !== input.tool || existing.payloadHash !== payloadHash) throw new AgentError("agent.session_busy", "Another approval is already pending on this session");
        return existing;
      }
      const now = this.now();
      const approval: AgentApproval = {
        id: id("appr"),
        sessionId,
        turnId: input.turnId ?? null,
        tool: input.tool,
        payload: input.payload,
        payloadHash,
        status: "pending",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + definition.approvals.timeout_minutes * 60_000).toISOString(),
        decidedAt: null,
        actor: null,
      };
      this.store.transaction(() => {
        this.store.insertApproval(approval);
        this.store.updateSession(sessionId, { status: "waiting" }, approval.createdAt);
      });
      return approval;
    });
  }

  async decideApproval(
    projectRoot: string,
    sessionId: string,
    decision: "approve" | "deny",
    actor: ApprovalActor,
  ): Promise<AgentApproval> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const session = this.sessionInProject(projectRoot, sessionId);
      const definition = await this.definitionAt(projectRoot, session.agentId, session.revision);
      if (!canApprove(definition, actor)) throw new AgentError("agent.approval_forbidden");
      const pending = this.store.getPendingApproval(sessionId);
      if (!pending) throw new AgentError("agent.approval_not_pending");
      if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
        this.expireApprovals();
        throw new AgentError("agent.approval_expired");
      }
      if (decision === "approve") {
        // Disable while waiting refuses the action (R9); denial is always allowed.
        const { revision: live } = this.currentRevision(projectRoot, session.agentId);
        if (!live.definition.enabled) throw new AgentError("agent.disabled");
      }
      const decided = this.lifecycle.decide(pending, decision, actor);
      if (decided === "stale") throw new AgentError("agent.approval_not_pending");
      return decided.approval;
    });
  }

  async pendingApprovals(projectRoot: string): Promise<Array<AgentApproval & { agentId: string }>> {
    this.expireApprovals();
    return this.store.listPendingApprovals(agentProjectKey(projectRoot));
  }

  /* ---------- communications ---------- */

  async receive(
    projectRoot: string,
    message: AgentInboundMessage,
  ): Promise<{ agentId: string; sessionId: string; duplicate: boolean }> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      const bound = this.store
        .listDefinitions(projectKey)
        .filter((row) => !row.archived && row.currentRevision > 0)
        .map((row) => this.store.getRevision(projectKey, row.agentId, row.currentRevision)!)
        .filter((revision) => revision.definition.channel?.connection_id === message.connectionId);
      const target = bound.find((revision) => revision.definition.enabled) ?? bound[0];
      if (!target) throw new AgentError("agent.unbound");
      if (!target.definition.enabled) throw new AgentError("agent.disabled");
      if (!senderAllowed(target.definition.channel?.allow_from ?? [], message.from)) throw new AgentError("agent.sender_not_allowed");
      const threadKey = agentThreadKey(message);
      const now = this.iso();
      const existing = this.store.findSessionByThread(projectKey, target.agentId, threadKey);
      if (!this.store.rememberInboundEvent(projectKey, inboundDedupeKey(message), now)) {
        if (!existing) throw new AgentError("agent.session_not_found");
        return { agentId: target.agentId, sessionId: existing.id, duplicate: true };
      }
      if (existing) return { agentId: target.agentId, sessionId: existing.id, duplicate: false };
      const session: AgentSession = {
        id: id("ses"),
        agentId: target.agentId,
        revision: target.revision,
        backend: target.definition.model.backend,
        status: "open",
        source: message.provider,
        sourceRef: message.from ?? null,
        threadKey,
        title: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.insertSession(projectKey, session);
      return { agentId: target.agentId, sessionId: session.id, duplicate: false };
    });
  }

  /**
   * At-most-once outbound send keyed by operation. A send whose outcome is
   * unknown (crash between submit and record) is never retried automatically.
   */
  async sendOutbound(
    projectRoot: string,
    sessionId: string,
    operationKey: string,
    submit: () => Promise<void>,
  ): Promise<{ state: "submitted"; resent: boolean }> {
    this.sessionInProject(projectRoot, sessionId);
    const existing = this.store.getOutboundState(sessionId, operationKey);
    if (existing === "submitted") return { state: "submitted", resent: false };
    if (existing === "unknown") throw new AgentError("agent.outbound_unknown");
    this.store.setOutboundState(sessionId, operationKey, "unknown", this.iso());
    try {
      await submit();
    } catch (error) {
      // Say why (a channel error code or system message, never the message text) so a lost reply can be diagnosed.
      const why = (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.message : String(error));
      throw new AgentError("agent.outbound_unknown", `The reply could not be sent: ${String(why)}`);
    }
    this.store.setOutboundState(sessionId, operationKey, "submitted", this.iso());
    return { state: "submitted", resent: true };
  }

  /* ---------- schedules ---------- */

  async scheduledAgents(projectRoot: string): Promise<Array<{ agentId: string; schedule: NonNullable<AgentDefinition["schedule"]> }>> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      const rows: Array<{ agentId: string; schedule: NonNullable<AgentDefinition["schedule"]> }> = [];
      for (const row of this.store.listDefinitions(projectKey)) {
        if (row.archived || row.currentRevision === 0) continue;
        const definition = this.store.getRevision(projectKey, row.agentId, row.currentRevision)?.definition;
        if (definition?.enabled && definition.schedule) rows.push({ agentId: row.agentId, schedule: definition.schedule });
      }
      return rows;
    });
  }
}

export function hashApprovalPayload(payload: Record<string, unknown>): string {
  return sha256(stableJson(payload));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
