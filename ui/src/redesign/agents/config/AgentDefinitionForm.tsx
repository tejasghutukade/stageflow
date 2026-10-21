import { useEffect, useState, type ReactNode } from "react";
import { showToast } from "../../../toast";
import { ModelPicker } from "../../../components/ModelPicker";
import {
  LuClock,
  LuCopy,
  LuCpu,
  LuGlobe,
  LuLock,
  LuMessageSquare,
  LuPencil,
  LuPlug,
  LuPlus,
  LuRotateCcw,
  LuShield,
  LuTriangleAlert,
  LuUserCheck,
} from "react-icons/lu";
import { contactLines } from "../model/channelContact";
import { agentsApi, type AgentDefinition, type ChannelContact, type AgentIssue, type AgentRevisionMeta, type BuiltinToolGroup, type ChannelListenerState } from "../../../api/agents";
import { fetchMemories, type MemorySummary } from "../../../api";
import { MONO, NOWRAP } from "../agentsTokens";
import {
  addedLineCount,
  approvalRows,
  riskyGrantIds,
  DEFAULT_WEB_CHAT,
  issuesAt,
  pruneAskFirst,
  rowAsksFirst,
  setRowAsksFirst,
  type SectionId,
} from "../model/definition";
import type { EditorOptions } from "../model/hooks";
import {
  ChangedDot,
  ChipListField,
  Field,
  FieldMessages,
  ListGroup,
  NumberField,
  SectionHeading,
  Segmented,
  SelectField,
  TextBox,
  Toggle,
} from "../ui";
import { InstructionsEditor } from "./InstructionsEditor";
import { McpToolPicker } from "./McpToolPicker";
import { PermissionTree } from "./PermissionTree";
import { BUILTIN_PERMISSION_GROUPS, grantedToolIds, operatorOnlyToolNames, stageflowPermissionGroups } from "../model/permissions";

const STREAMED_PROVIDERS = ["agentmail", "imessage"];

/** Whether the Host is listening on this agent's connection, refreshed while the page is open. */
function ChannelStatus({ agentId, provider, enabled }: { agentId: string; provider: string | undefined; enabled: boolean }) {
  const [state, setState] = useState<ChannelListenerState | undefined>();
  const [undelivered, setUndelivered] = useState<{ message: string | null; code: string | null } | undefined>();
  useEffect(() => {
    if (!provider || !STREAMED_PROVIDERS.includes(provider)) return;
    let live = true;
    const load = () => agentsApi.channelStatus(agentId).then((body) => { if (!live) return; setState(body.listener); setUndelivered(body.lastUndelivered ? { message: body.lastUndelivered.message, code: body.lastUndelivered.code } : undefined); }, () => undefined);
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [agentId, provider]);
  if (!provider) return null;
  const streamed = STREAMED_PROVIDERS.includes(provider);
  const { text, tone } = !streamed
    ? { text: "Receives messages by webhook", tone: "muted" }
    : !enabled
      ? { text: "Not listening. Enable the agent to start.", tone: "muted" }
      : !state
        ? { text: "Starting…", tone: "muted" }
        : state.status === "connected"
          ? { text: `Listening · ${state.received} message${state.received === 1 ? "" : "s"} since it started`, tone: "ok" }
          : { text: `${state.status === "failed" ? "Cannot connect" : "Reconnecting"}${state.error ? `: ${state.error}` : ""}`, tone: "bad" };
  const failure = undelivered ? (
    <span className="text-xs leading-normal text-[var(--sf-fail)]" data-testid="channel-undelivered">
      The last reply that failed to send: {undelivered.message ?? undelivered.code ?? "unknown reason"} Open that run to resend it.
    </span>
  ) : null;
  return (
    <div className="flex flex-col gap-1">
    {failure}
    <span className={`flex items-center gap-1.5 text-xs leading-normal ${tone === "ok" ? "text-[var(--sf-ok)]" : tone === "bad" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`} data-testid="channel-status">
      <span className={`block size-1.5 rounded-full ${tone === "ok" ? "bg-[var(--sf-ok)]" : tone === "bad" ? "bg-[var(--sf-fail)]" : "bg-[var(--sf-text-3)]"}`} />
      {text}
    </span>
    </div>
  );
}

/** The number to text for an iMessage agent, looked up from Photon. */
function ChannelContactInfo({ agentId, allowFrom }: { agentId: string; allowFrom: readonly string[] }) {
  const [contact, setContact] = useState<ChannelContact | undefined | null>(undefined);
  useEffect(() => {
    let live = true;
    agentsApi.channelContact(agentId).then((body) => live && setContact(body.contact ?? null), () => live && setContact(null));
    return () => {
      live = false;
    };
  }, [agentId]);
  if (contact === undefined) return <span className="text-xs text-[var(--sf-text-3)]">Looking up the number…</span>;
  if (contact === null) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="channel-contact">
      {contactLines(contact, allowFrom).map((line, index) => (
        <span key={index} className={`text-xs leading-normal ${line.tone === "ok" ? "text-[var(--sf-text-1)]" : line.tone === "warn" ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-3)]"}`}>
          {line.text}
        </span>
      ))}
    </div>
  );
}

export type FormMode = "create" | "edit" | "view";

export const CREATE_SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "instructions", label: "Instructions" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools and access" },
  { id: "approvals", label: "Approvals" },
  { id: "observability", label: "Observability" },
  { id: "webchat", label: "Web chat" },
];

export const EDIT_SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "instructions", label: "Instructions" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools and access" },
  { id: "subagents", label: "Sub-agents" },
  { id: "approvals", label: "Approvals" },
  { id: "evals", label: "Guardrails and evals" },
  { id: "observability", label: "Observability" },
  { id: "webchat", label: "Web chat" },
  { id: "channels", label: "Channels and triggers" },
  { id: "limits", label: "Limits" },
  { id: "versions", label: "Version history" },
];

export function sectionDomId(id: SectionId): string {
  return `agent-config-${id}`;
}

export type VersionHistory = {
  revisions: AgentRevisionMeta[];
  current: number;
  onCompare: (revision: number) => void;
  onRestore: (revision: number) => void;
};

type Props = {
  mode: FormMode;
  definition: AgentDefinition;
  onChange?: (next: AgentDefinition) => void;
  /** Saved revision, for change markers in edit mode. */
  saved?: AgentDefinition | null;
  issues: AgentIssue[];
  warnings: AgentIssue[];
  options: EditorOptions;
  /** Revision the span preview names; the next save becomes revision + 1. */
  revision?: number;
  versions?: VersionHistory;
  onOpenAgent?: (agentId: string) => void;
  /** Create mode: the instructions came from the agent author. */
  authorWroteInstructions?: boolean;
  /** Shareable link of the saved agent; null until web chat has a slug. */
  webChatUrl?: string | null;
};

const TIMEOUTS = [5, 15, 30, 60, 240, 1440];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section id={sectionDomId(id)} className="flex scroll-mt-4 flex-col gap-4">
      {children}
    </section>
  );
}

function RowIcon({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span className={`flex shrink-0 [&>svg]:size-3.5 ${muted ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-2)]"}`}>
      {children}
    </span>
  );
}

function LinkButton({ children, onClick, tone = "text-2" }: { children: ReactNode; onClick?: () => void; tone?: "text-2" | "text-3" | "fail" }) {
  const color = tone === "fail" ? "text-[var(--sf-fail)]" : tone === "text-3" ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-2)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-1 text-xs leading-[1.33333] ${color} hover:text-[var(--sf-text-1)] disabled:pointer-events-none ${NOWRAP}`}
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{children}</p>;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const SOURCE_LABEL: Record<AgentRevisionMeta["source"], string> = {
  console: "Console",
  file: "File edit",
  author: "Agent author",
  restore: "Restore",
  api: "API",
};

export function AgentDefinitionForm({
  mode,
  definition: def,
  onChange,
  saved,
  issues,
  warnings,
  options,
  revision = 0,
  versions,
  onOpenAgent,
  authorWroteInstructions = false,
  webChatUrl = null,
}: Props) {
  const editable = mode !== "view" && onChange !== undefined;
  const full = mode !== "create";
  const markChanges = mode === "edit" && saved != null;
  const update = editable ? (next: AgentDefinition) => onChange!(pruneAskFirst(next)) : undefined;
  const at = (path: string) => ({ issues: issuesAt(issues, path), warnings: issuesAt(warnings, path) });
  const changed = (value: unknown, savedValue: unknown) => markChanges && JSON.stringify(value) !== JSON.stringify(savedValue);
  const field = <K extends keyof AgentDefinition>(key: K) =>
    update ? (value: AgentDefinition[K]) => update({ ...def, [key]: value }) : undefined;
  const text = (key: "name" | "description" | "greeting") =>
    update ? (value: string) => update({ ...def, [key]: value || undefined } as AgentDefinition) : undefined;

  const usedBy = Object.fromEntries((options.agents ?? []).filter((agent) => agent.channelConnection && agent.id !== def.id).map((agent) => [agent.channelConnection!, agent.name]));
  const mcpCatalog = options.mcpServers ?? [];
  const mcpNames = [...new Set([...mcpCatalog.map((server) => server.name), ...Object.keys(def.tools.mcp)])];
  const rows = approvalRows(def);
  const addedLines = markChanges ? addedLineCount(def.instructions, saved!.instructions) : 0;
  const approverMode = def.approvals.approvers.operators
    ? def.approvals.approvers.channel_ids.length > 0
      ? "both"
      : "operators"
    : "channels";
  const webChat = def.web_chat ?? DEFAULT_WEB_CHAT;
  const savedSlug = saved?.web_chat?.slug;
  const setWebChat = (patch: Partial<NonNullable<AgentDefinition["web_chat"]>>) =>
    update?.({ ...def, web_chat: { ...webChat, ...patch } });
  // Rotating = the saved link is dropped from the draft; the server mints a new slug on save.
  const rotating = Boolean(savedSlug) && !webChat.slug;
  const setTools = (tools: AgentDefinition["tools"]) => update?.({ ...def, tools });
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const stageflow = def.tools.stageflow ?? { groups: [], tools: [] };
  const catalog = options.stageflow;
  const setStageflow = (next: { groups: string[]; tools: string[] }, askAdd: string[] = []) => {
    const ask = [...new Set([...def.approvals.ask_first, ...askAdd])];
    update?.({ ...def, tools: { ...def.tools, stageflow: next }, approvals: { ...def.approvals, ask_first: ask } });
  };
  const toggleOpen = (id: string) => setOpenGroups((open) => (open.includes(id) ? open.filter((item) => item !== id) : [...open, id]));
  const stageflowGroups = catalog ? stageflowPermissionGroups(catalog) : [];
  const grantsWrite = grantedToolIds({ groups: def.tools.builtin, tools: def.tools.builtin_tools ?? [] }, BUILTIN_PERMISSION_GROUPS).some((id) => id === "write" || id === "edit" || id === "bash");
  const setMcp = (server: string, tools: string[] | null) => {
    const mcp = { ...def.tools.mcp };
    if (tools === null) delete mcp[server];
    else mcp[server] = tools;
    setTools({ ...def.tools, mcp });
  };

  return (
    <div className="flex flex-col gap-8 px-7 py-6">
      {/* ---------- identity ---------- */}
      <Section id="identity">
        <SectionHeading>Identity</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" changed={changed(def.name, saved?.name)}>
            <TextBox value={def.name} onChange={text("name")} placeholder="Research assistant" ariaLabel="Name" invalid={at("name").issues.length > 0} />
            <FieldMessages {...at("name")} />
          </Field>
          <Field label="Description" changed={changed(def.description, saved?.description)}>
            <TextBox value={def.description ?? ""} onChange={text("description")} placeholder="What this agent is for" ariaLabel="Description" />
            <FieldMessages {...at("description")} />
          </Field>
          <Field label="Greeting" changed={changed(def.greeting, saved?.greeting)}>
            <TextBox value={def.greeting ?? ""} onChange={text("greeting")} placeholder="What should I look into?" ariaLabel="Greeting" />
            <FieldMessages {...at("greeting")} />
          </Field>
        </div>
      </Section>

      {/* ---------- instructions ---------- */}
      <Section id="instructions">
        <SectionHeading
          aside={
            addedLines > 0 ? (
              <span className="flex items-center gap-1.5 text-[11px] leading-normal text-[var(--sf-running)]">
                <ChangedDot />
                {addedLines} line{addedLines === 1 ? "" : "s"} added
              </span>
            ) : authorWroteInstructions ? (
              <span className="flex items-center gap-1 text-[11px] leading-normal text-[#a78bfa]">
                <LuPencil aria-hidden className="size-3" />
                Written by agent author
              </span>
            ) : null
          }
        >
          Instructions
        </SectionHeading>
        <InstructionsEditor
          value={def.instructions}
          onChange={update ? (value) => update({ ...def, instructions: value }) : undefined}
          baseline={markChanges ? saved!.instructions : undefined}
          placeholder="You are the research assistant for #research. …"
        />
        <FieldMessages {...at("instructions")} />
        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--sf-hairline)] px-3.5 py-3">
          <div className="flex items-start gap-2.5">
            <LuLock aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--sf-text-2)]" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Read project context</span>
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                {def.project_context
                  ? "On: the agent also reads AGENTS.md, project skills and extensions."
                  : "Off: the agent ignores AGENTS.md, project skills and extensions, and only sees these instructions."}
              </span>
            </div>
          </div>
          <Toggle on={def.project_context} onChange={field("project_context")} label="Read project context" />
        </div>
      </Section>

      {/* ---------- model ---------- */}
      <Section id="model">
        <SectionHeading>Model</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Model" changed={changed(def.model.id, saved?.model.id)}>
            <ModelPicker
              ariaLabel="Model"
              value={def.model.id ?? null}
              inheritLabel="Project default"
              warnUnknown={false}
              disabled={!update}
              error={at("model.id").issues.length > 0}
              onChange={(value) => {
                if (!update) return;
                const { id: _drop, ...rest } = def.model;
                update({ ...def, model: value ? { ...rest, id: value } : rest });
              }}
            />
            <FieldMessages {...at("model.id")} />
          </Field>
          <Field
            label="Thinking"
            changed={changed(def.model.thinking, saved?.model.thinking)}
            hint={
              markChanges && saved && def.model.thinking !== saved.model.thinking
                ? `Changed from ${saved.model.thinking}.`
                : "Lower is faster: reasoning models can think for a minute or more before they answer."
            }
            hintTone={markChanges && saved && def.model.thinking !== saved.model.thinking ? "changed" : undefined}
          >
            <Segmented
              options={["Off", "Low", "Medium", "High"]}
              value={def.model.thinking[0]!.toUpperCase() + def.model.thinking.slice(1)}
              onChange={update ? (value) => update({ ...def, model: { ...def.model, thinking: value.toLowerCase() as AgentDefinition["model"]["thinking"] } }) : undefined}
              changed={changed(def.model.thinking, saved?.model.thinking)}
            />
          </Field>
        </div>
        <Note>Project default uses the model set in stageflow.yaml, else the first free model of a connected provider.</Note>
      </Section>

      {/* ---------- tools ---------- */}
      <Section id="tools">
        <SectionHeading aside={markChanges && changed(def.tools, saved?.tools) ? <ChangedDot /> : undefined}>Tools and access</SectionHeading>
        <div className="flex flex-col gap-2" data-testid="builtin-tools">
          <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Files and shell</span>
          <PermissionTree
            groups={BUILTIN_PERMISSION_GROUPS}
            grants={{ groups: def.tools.builtin, tools: def.tools.builtin_tools ?? [] }}
            onChange={update ? (next) => setTools({ ...def.tools, builtin: next.groups as BuiltinToolGroup[], builtin_tools: next.tools }) : undefined}
            openGroups={openGroups}
            onToggleOpen={toggleOpen}
            askFirst={def.approvals.ask_first}
          />
          <span className="flex items-start gap-2 text-xs leading-normal text-[var(--sf-text-3)]">
            <LuLock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {grantsWrite
              ? "Writes stay inside the project root. Agent definitions and Stageflow state are never writable."
              : "Can't write anywhere. Tick a write tool to change files. Stageflow sets the project root; the agent can never choose a path."}
          </span>
        </div>
        <AgentMemoriesField definition={def} onChange={update} />

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">MCP servers</span>
          {mcpNames.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-3.5 py-3 text-xs text-[var(--sf-text-3)]">
              {options.mcpServers === undefined
                ? "Loading servers…"
                : options.mcpStatus === "invalid_config"
                  ? ".mcp.json could not be read. Fix it to grant MCP tools."
                  : "No MCP servers yet. Add one in Settings → Project MCP to grant its tools."}
            </div>
          ) : (
            <ListGroup>
              {mcpNames.map((server) => {
                const granted = def.tools.mcp[server];
                const known = mcpCatalog.some((entry) => entry.name === server);
                const all = granted?.includes("*") ?? false;
                return (
                  <div key={server} className="flex flex-col gap-2.5 px-3.5 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className={`${MONO} text-[13px] leading-normal ${granted ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>{server}</span>
                          {!known ? (
                            <span className="flex items-center gap-1 text-[11px] leading-normal text-[var(--sf-needs)]">
                              <LuTriangleAlert aria-hidden className="size-3" />
                              Not in .mcp.json
                            </span>
                          ) : null}
                        </div>
                        <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                          {!granted
                            ? "In the project, not given to this agent"
                            : all
                              ? "Every tool on this server is allowed"
                              : `${granted.length} tool${granted.length === 1 ? "" : "s"} allowed`}
                        </span>
                      </div>
                      {granted ? (
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1.5 text-xs text-[var(--sf-text-2)]">
                            <Toggle on={all} onChange={update ? (next) => setMcp(server, next ? ["*"] : []) : undefined} label={`All ${server} tools`} />
                            All tools
                          </label>
                          <LinkButton tone="text-3" onClick={update ? () => setMcp(server, null) : undefined}>
                            Remove
                          </LinkButton>
                        </div>
                      ) : (
                        <LinkButton onClick={update ? () => setMcp(server, []) : undefined}>
                          <LuPlus aria-hidden className="size-3" />
                          Allow
                        </LinkButton>
                      )}
                    </div>
                    {granted && !all ? (
                      <McpToolPicker server={server} granted={granted} onChange={update ? (tools) => setMcp(server, tools) : undefined} />
                    ) : null}
                    <FieldMessages {...at(`tools.mcp.${server}`)} />
                  </div>
                );
              })}
            </ListGroup>
          )}
        </div>

        <div className="flex flex-col gap-2" data-testid="stageflow-tools">
          <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Stageflow tools</span>
          <span className="text-xs leading-normal text-[var(--sf-text-3)]">
            Let this agent run Stageflow itself: watch and start runs, author pipelines, manage triggers and agents. It can never give another agent a tool it does not hold. Ticking a group sets everything that is not read-only to ask first.
          </span>
          {!catalog ? (
            <div className="rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-3.5 py-3 text-xs text-[var(--sf-text-3)]">Loading tools…</div>
          ) : (
            <PermissionTree
              groups={stageflowGroups}
              grants={stageflow}
              onChange={update ? (next, added) => setStageflow(next, added.toolIds.flatMap((id) => riskyGrantIds(catalog, added.groupId, id))) : undefined}
              openGroups={openGroups}
              onToggleOpen={toggleOpen}
              askFirst={def.approvals.ask_first}
              askId={(id) => `stageflow.${id}`}
            />
          )}
          {catalog && operatorOnlyToolNames(catalog).length > 0 ? (
            <span className="flex items-start gap-2 text-xs leading-normal text-[var(--sf-text-3)]">
              <LuLock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Not offered to agents, because only a person should do them: {operatorOnlyToolNames(catalog).join(", ")}.
            </span>
          ) : null}
          <FieldMessages {...at("tools.stageflow")} />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--sf-hairline)] px-3.5 py-3">
            <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Skills</span>
            <ChipListField
              values={def.tools.skills}
              onChange={update ? (skills) => setTools({ ...def.tools, skills }) : undefined}
              suggestions={(options.skills ?? []).map((skill) => skill.name)}
              placeholder="Add a skill"
              ariaLabel="Skills"
            />
            <FieldMessages {...at("tools.skills")} />
          </div>
          <div className="flex items-start justify-between gap-2 rounded-lg border border-[var(--sf-hairline)] px-3.5 py-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Browser</span>
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{def.tools.browser ? "On" : "Off"}</span>
            </div>
            <Toggle on={def.tools.browser} onChange={update ? (browser) => setTools({ ...def.tools, browser }) : undefined} label="Browser" />
          </div>
          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--sf-hairline)] px-3.5 py-3">
            <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Secrets</span>
            <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">None. MCP servers bring their own.</span>
          </div>
        </div>
      </Section>

      {/* ---------- sub-agents ---------- */}
      {full ? (
        <Section id="subagents">
          <SectionHeading note="Agents this one can call. Each runs with its own model, tools and approvals, and shows up as a nested span.">
            Sub-agents
          </SectionHeading>
          {def.sub_agents.length > 0 ? (
            <ListGroup>
              {def.sub_agents.map((agentId) => {
                const info = options.agents?.find((agent) => agent.id === agentId);
                return (
                  <div key={agentId} className="flex items-center justify-between gap-3 px-3.5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-7 items-center justify-center rounded-md bg-[#a78bfa1f]">
                        <LuCpu aria-hidden className="size-3.5 text-[#a78bfa]" />
                      </span>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{info?.name ?? agentId}</span>
                        <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                          {info ? `${info.model} · ${info.enabled ? "enabled" : "disabled"}` : "Agent not found"}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {onOpenAgent && info ? <LinkButton onClick={() => onOpenAgent(agentId)}>Open agent</LinkButton> : null}
                      <LinkButton tone="text-3" onClick={update ? () => update({ ...def, sub_agents: def.sub_agents.filter((id) => id !== agentId) }) : undefined}>
                        Remove
                      </LinkButton>
                    </div>
                  </div>
                );
              })}
            </ListGroup>
          ) : (
            <Note>No sub-agents. This agent can't call other agents.</Note>
          )}
          {editable ? (
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-64">
                <SelectField
                  value=""
                  ariaLabel="Add sub-agent"
                  options={[
                    { value: "", label: "Add sub-agent…" },
                    ...(options.agents ?? [])
                      .filter((agent) => agent.id !== def.id && !def.sub_agents.includes(agent.id))
                      .map((agent) => ({ value: agent.id, label: agent.name })),
                  ]}
                  onChange={(value) => value && update!({ ...def, sub_agents: [...def.sub_agents, value] })}
                />
              </div>
              {def.sub_agents.length > 0 ? (
                <div className="w-40">
                  <Field label="Nesting depth">
                    <NumberField value={def.sub_agent_depth} min={1} max={5} onChange={(value) => update!({ ...def, sub_agent_depth: value ?? 1 })} ariaLabel="Nesting depth" />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}
          <FieldMessages {...at("sub_agents")} />
        </Section>
      ) : null}

      {/* ---------- approvals ---------- */}
      <Section id="approvals">
        <SectionHeading note="Tools that send, write or delete should ask a person first. Reading tools can run on their own.">Approvals</SectionHeading>
        {rows.length === 0 ? (
          <Note>Grant tools above to choose which ones ask first.</Note>
        ) : (
          <div className="flex flex-col overflow-x-auto rounded-lg border border-[var(--sf-hairline)]">
            <div className="grid min-w-[520px] grid-cols-[200px_1fr_160px] gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2">
              {["Tool", "What it does", "Ask first"].map((label) => (
                <span key={label} className="text-[11px] leading-normal text-[var(--sf-text-3)]">
                  {label}
                </span>
              ))}
            </div>
            {rows.map((row, index) => {
              const asks = rowAsksFirst(def, row);
              return (
                <div
                  key={row.tool}
                  className={`grid min-w-[520px] grid-cols-[200px_1fr_160px] items-center gap-3 px-3.5 py-2 ${
                    index < rows.length - 1 ? "border-b border-b-[var(--sf-hairline)]" : ""
                  } ${asks ? "bg-[#f5b5440a]" : ""}`}
                >
                  <span className={`${MONO} text-xs leading-[1.33333] ${row.kind === "agent" ? "text-[#a78bfa]" : "text-[var(--sf-text-1)]"}`}>{row.label}</span>
                  <span className="text-xs leading-[1.33333] text-[var(--sf-text-2)]">{row.effect}</span>
                  {editable ? (
                    <SelectField
                      value={asks ? "always" : "never"}
                      ariaLabel={`Ask first for ${row.label}`}
                      options={[
                        { value: "never", label: "Never" },
                        { value: "always", label: "Every time" },
                      ]}
                      onChange={(value) => update!(setRowAsksFirst(def, row, value === "always"))}
                    />
                  ) : asks ? (
                    <span className="flex w-fit items-center gap-1 rounded-md bg-[#f5b5441f] px-1.5 py-0.5">
                      <LuUserCheck aria-hidden className="size-3 text-[var(--sf-needs)]" />
                      <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-needs)]">Every time</span>
                    </span>
                  ) : (
                    <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Never</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {Object.values(def.tools.mcp).some((tools) => tools.includes("*")) ? (
          <Note>
            For servers with all tools allowed, add ask-first tools by name:{" "}
          </Note>
        ) : null}
        {Object.entries(def.tools.mcp)
          .filter(([, tools]) => tools.includes("*"))
          .map(([server]) => (
            <ChipListField
              key={server}
              values={def.approvals.ask_first.filter((tool) => tool.startsWith(`${server}.`)).map((tool) => tool.slice(server.length + 1))}
              onChange={
                update
                  ? (names) =>
                      update({
                        ...def,
                        approvals: {
                          ...def.approvals,
                          ask_first: [
                            ...def.approvals.ask_first.filter((tool) => !tool.startsWith(`${server}.`)),
                            ...names.map((name) => `${server}.${name}`),
                          ],
                        },
                      })
                  : undefined
              }
              placeholder={`${server} tools that ask first`}
              ariaLabel={`${server} ask-first tools`}
            />
          ))}
        <FieldMessages {...at("approvals.ask_first")} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Who approves" changed={changed(def.approvals.approvers, saved?.approvals.approvers)}>
            <SelectField
              value={approverMode}
              ariaLabel="Who approves"
              options={[
                { value: "operators", label: "Any operator" },
                { value: "both", label: "Operators and trusted channel people" },
                { value: "channels", label: "Only trusted channel people" },
              ]}
              onChange={
                update
                  ? (value) =>
                      update({
                        ...def,
                        approvals: {
                          ...def.approvals,
                          approvers: { ...def.approvals.approvers, operators: value !== "channels" },
                        },
                      })
                  : undefined
              }
            />
            {approverMode !== "operators" ? (
              <ChipListField
                values={def.approvals.approvers.channel_ids}
                onChange={
                  update
                    ? (channel_ids) => update({ ...def, approvals: { ...def.approvals, approvers: { ...def.approvals.approvers, channel_ids } } })
                    : undefined
                }
                placeholder="Channel identity, e.g. slack:U0123ABC"
                ariaLabel="Trusted channel identities"
              />
            ) : null}
            <FieldMessages {...at("approvals.approvers")} />
          </Field>
          <Field label="If nobody answers" changed={changed([def.approvals.timeout_minutes, def.approvals.on_timeout], [saved?.approvals.timeout_minutes, saved?.approvals.on_timeout])}>
            <div className="grid grid-cols-2 gap-2">
              <SelectField
                value={String(def.approvals.timeout_minutes)}
                ariaLabel="Approval timeout"
                options={[...new Set([...TIMEOUTS, def.approvals.timeout_minutes])]
                  .sort((a, b) => a - b)
                  .map((minutes) => ({
                    value: String(minutes),
                    label: minutes < 60 ? `Wait ${minutes} min` : `Wait ${minutes / 60} h`,
                  }))}
                onChange={update ? (value) => update({ ...def, approvals: { ...def.approvals, timeout_minutes: Number(value) } }) : undefined}
              />
              <SelectField
                value={def.approvals.on_timeout}
                ariaLabel="When the wait ends"
                options={[
                  { value: "skip", label: "then skip the step" },
                  { value: "deny", label: "then refuse it" },
                ]}
                onChange={update ? (value) => update({ ...def, approvals: { ...def.approvals, on_timeout: value } }) : undefined}
              />
            </div>
          </Field>
        </div>
      </Section>

      {/* ---------- guardrails and evals ---------- */}
      {full ? (
        <Section id="evals">
          <SectionHeading>Guardrails and evals</SectionHeading>
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] px-3.5 py-3">
            <div className="flex items-center gap-2.5">
              <LuShield aria-hidden className="size-3.5 shrink-0 text-[#f472b6]" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] leading-normal text-[var(--sf-text-1)]">Block replies that match</span>
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                  JavaScript regular expressions checked against every reply. A match fails the turn.
                </span>
              </div>
            </div>
            <ChipListField
              values={def.guardrails.block_patterns}
              onChange={update ? (block_patterns) => update({ ...def, guardrails: { block_patterns } }) : undefined}
              placeholder="e.g. internal-only|confidential"
              ariaLabel="Block patterns"
            />
            <FieldMessages {...at("guardrails")} />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--sf-hairline)] px-3.5 py-3">
            <div className="flex items-center gap-2.5">
              <LuShield aria-hidden className="size-3.5 shrink-0 text-[#f472b6]" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] leading-normal text-[var(--sf-text-1)]">Groundedness eval</span>
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">After a reply that used tools, a judge scores how well the tool results support it (0–1).</span>
              </div>
            </div>
            <Toggle
              on={def.evals.groundedness}
              label="Groundedness eval"
              onChange={update ? (groundedness) => update({ ...def, evals: { ...def.evals, groundedness } }) : undefined}
            />
          </div>
        </Section>
      ) : null}

      {/* ---------- observability ---------- */}
      <Section id="observability">
        <SectionHeading>Observability</SectionHeading>
        <Field
          label="Content capture"
          changed={changed(def.observability.capture, saved?.observability.capture)}
          hint={
            def.observability.capture === "full"
              ? "Prompts, tool arguments and results are saved on each span. Secrets, emails and tokens are masked before saving."
              : def.observability.capture === "metadata"
                ? "Spans keep timing, status and token counts. No prompt or tool content is saved."
                : "No spans are recorded. The conversation transcript is still kept."
          }
        >
          <Segmented
            options={["Off", "Timing only", "Full content"]}
            value={{ off: "Off", metadata: "Timing only", full: "Full content" }[def.observability.capture]}
            onChange={
              update
                ? (value) =>
                    update({
                      ...def,
                      observability: {
                        ...def.observability,
                        capture: value === "Off" ? "off" : value === "Full content" ? "full" : "metadata",
                      },
                    })
                : undefined
            }
            changed={changed(def.observability.capture, saved?.observability.capture)}
            className="w-full max-w-[420px]"
          />
        </Field>
        <ListGroup>
          <div className="flex items-center justify-between px-3.5 py-3">
            <span className="text-[13px] leading-normal text-[var(--sf-text-1)]">Stageflow console</span>
            <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Always on</span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] leading-normal text-[var(--sf-text-1)]">Also send to an OTLP collector</span>
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Sends each finished turn to the collector set by OTEL_EXPORTER_OTLP_ENDPOINT on the Host.</span>
            </div>
            <Toggle
              on={def.observability.otlp}
              label="Send to OTLP collector"
              onChange={update ? (otlp) => update({ ...def, observability: { ...def.observability, otlp } }) : undefined}
            />
          </div>
        </ListGroup>
        <p className={`${MONO} text-[11px] leading-[1.6] text-[var(--sf-text-3)]`}>
          Spans carry gen_ai.agent.name={def.id || "…"}
          {revision > 0 ? ` · stageflow.agent.config=v${revision}` : ""}
          {markChanges && changed(def, saved) ? ` (v${revision + 1} after save)` : ""}
        </p>
      </Section>

      {/* ---------- web chat ---------- */}
      <Section id="webchat">
        <SectionHeading>Web chat</SectionHeading>
        <ListGroup>
          <div className="flex items-center justify-between gap-4 px-3.5 py-3">
            <div className="flex items-center gap-2.5">
              <RowIcon muted={!webChat.enabled}>
                <LuGlobe />
              </RowIcon>
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">
                  Public chat page
                  {changed(webChat.enabled, saved?.web_chat?.enabled ?? false) ? <ChangedDot /> : null}
                </span>
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                  Anyone with the link can chat with this agent. Visitors stay anonymous and can only chat.
                </span>
              </div>
            </div>
            <Toggle on={webChat.enabled} label="Public chat page" onChange={update ? (enabled) => setWebChat({ enabled }) : undefined} />
          </div>
          {webChat.enabled ? (
            <div className="flex flex-col gap-2 px-3.5 py-3">
              {webChatUrl && !rotating ? (
                <div className="flex items-center justify-between gap-3">
                  <span className={`${MONO} min-w-0 truncate text-xs text-[var(--sf-text-1)]`} title={webChatUrl}>
                    {webChatUrl}
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <LinkButton
                      onClick={() =>
                        void navigator.clipboard?.writeText(webChatUrl).then(
                          () => showToast("Link copied"),
                          () => showToast("Could not copy the link"),
                        )
                      }
                    >
                      <LuCopy aria-hidden className="size-3" />
                      Copy link
                    </LinkButton>
                    {update ? (
                      <LinkButton tone="text-3" onClick={() => setWebChat({ slug: undefined })}>
                        <LuRotateCcw aria-hidden className="size-3" />
                        Rotate link
                      </LinkButton>
                    ) : null}
                  </div>
                </div>
              ) : (
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-2)]">
                  {rotating ? "A new link is created when you save. The old link stops working." : "The link appears after you save."}
                </span>
              )}
              {webChatUrl && !rotating && update ? <Note>Rotating replaces the link when you save; the old one stops working.</Note> : null}
              <Note>The page only opens while the agent is enabled.</Note>
            </div>
          ) : null}
        </ListGroup>
        {webChat.enabled ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Messages per minute"
              changed={changed(webChat.rate_limit_per_minute, saved?.web_chat?.rate_limit_per_minute ?? DEFAULT_WEB_CHAT.rate_limit_per_minute)}
              hint="Per visitor. Visitors over the limit are asked to wait."
            >
              <NumberField
                value={webChat.rate_limit_per_minute}
                min={1}
                max={120}
                ariaLabel="Messages per minute"
                invalid={at("web_chat.rate_limit_per_minute").issues.length > 0}
                changed={changed(webChat.rate_limit_per_minute, saved?.web_chat?.rate_limit_per_minute ?? DEFAULT_WEB_CHAT.rate_limit_per_minute)}
                onChange={update ? (value) => setWebChat({ rate_limit_per_minute: value ?? 0 }) : undefined}
              />
              <FieldMessages {...at("web_chat.rate_limit_per_minute")} />
            </Field>
            <Field
              label="Longest message"
              changed={changed(webChat.max_message_chars, saved?.web_chat?.max_message_chars ?? DEFAULT_WEB_CHAT.max_message_chars)}
              hint="Characters a visitor can send in one message."
            >
              <NumberField
                value={webChat.max_message_chars}
                min={1}
                max={20000}
                suffix="chars"
                ariaLabel="Longest message"
                invalid={at("web_chat.max_message_chars").issues.length > 0}
                changed={changed(webChat.max_message_chars, saved?.web_chat?.max_message_chars ?? DEFAULT_WEB_CHAT.max_message_chars)}
                onChange={update ? (value) => setWebChat({ max_message_chars: value ?? 0 }) : undefined}
              />
              <FieldMessages {...at("web_chat.max_message_chars")} />
            </Field>
          </div>
        ) : null}
        <FieldMessages {...at("web_chat")} />
      </Section>

      {/* ---------- channels ---------- */}
      {full ? (
        <Section id="channels">
          <SectionHeading note="Where people can start a session with this agent.">Channels and triggers</SectionHeading>
          <ListGroup>
            <div className="flex items-center justify-between px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <RowIcon>
                  <LuMessageSquare />
                </RowIcon>
                <span className="text-[13px] leading-normal text-[var(--sf-text-1)]">Console, MCP and CLI</span>
                <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>sf agents chat {def.id}</span>
              </div>
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Always on</span>
            </div>
            <div className="flex flex-col gap-3 px-3.5 py-3" data-testid="agent-channel">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2.5">
                    <RowIcon muted={!def.channel}>
                      <LuPlug />
                    </RowIcon>
                    <span className={`text-[13px] leading-normal ${def.channel ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>Channel</span>
                    <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">One connection this agent answers on, like an AgentMail inbox or an iMessage line</span>
                  </div>
                </div>
                <SelectField
                  value={def.channel?.connection_id ?? ""}
                  ariaLabel="Channel connection"
                  options={[
                    { value: "", label: "None" },
                    ...(options.connections ?? []).map((connection) => ({
                      value: connection.id,
                      label: `${connection.displayName} · ${connection.provider}${connection.enabled ? "" : " (disabled)"}${usedBy[connection.id] ? ` · used by ${usedBy[connection.id]}` : ""}`,
                    })),
                    ...(def.channel && !(options.connections ?? []).some((c) => c.id === def.channel!.connection_id)
                      ? [{ value: def.channel.connection_id, label: `${def.channel.connection_id} (not in this project)` }]
                      : []),
                  ]}
                  onChange={
                    update
                      ? (value) => update({ ...def, channel: value === "" ? undefined : { connection_id: value, allow_from: def.channel?.allow_from ?? [] } })
                      : undefined
                  }
                />
              </div>
              {def.channel ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Who can message this agent</span>
                  <ChipListField
                    values={def.channel.allow_from}
                    onChange={update ? (allow_from) => update({ ...def, channel: { ...def.channel!, allow_from } }) : undefined}
                    placeholder="jane@example.com, +14155550123, @acme.com, or * for anyone"
                    ariaLabel="Allowed senders"
                  />
                  <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">
                    Emails, phone numbers in +country format, <span className={MONO}>@domain</span> for everyone at a domain, or <span className={MONO}>*</span> for anyone. Messages from anyone else are ignored, so an empty list means nobody.
                  </span>
                  {(options.connections ?? []).find((c) => c.id === def.channel!.connection_id)?.provider === "imessage" ? <ChannelContactInfo agentId={def.id} allowFrom={def.channel.allow_from} /> : null}
                  <ChannelStatus agentId={def.id} provider={(options.connections ?? []).find((c) => c.id === def.channel!.connection_id)?.provider} enabled={def.enabled} />
                  <FieldMessages {...at("channel.allow_from")} />
                  <FieldMessages {...at("channel.connection_id")} />
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-3 px-3.5 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <RowIcon muted={!def.schedule}>
                    <LuClock />
                  </RowIcon>
                  <span className={`text-[13px] leading-normal ${def.schedule ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>Schedule</span>
                  {!def.schedule ? <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">None</span> : null}
                </div>
                {def.schedule ? (
                  <LinkButton tone="text-3" onClick={update ? () => update({ ...def, schedule: undefined }) : undefined}>
                    Remove
                  </LinkButton>
                ) : (
                  <LinkButton onClick={update ? () => update({ ...def, schedule: { cron: "0 9 * * 1", timezone: "UTC" } }) : undefined}>
                    <LuPlus aria-hidden className="size-3" />
                    Add schedule
                  </LinkButton>
                )}
              </div>
              {def.schedule ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <Field label="Cron">
                    <TextBox
                      value={def.schedule.cron}
                      mono
                      ariaLabel="Cron"
                      invalid={at("schedule.cron").issues.length > 0}
                      onChange={update ? (cron) => update({ ...def, schedule: { ...def.schedule!, cron } }) : undefined}
                    />
                    <FieldMessages {...at("schedule.cron")} />
                  </Field>
                  <Field label="Timezone">
                    <TextBox
                      value={def.schedule.timezone ?? ""}
                      placeholder="UTC"
                      ariaLabel="Timezone"
                      onChange={update ? (timezone) => update({ ...def, schedule: { ...def.schedule!, timezone: timezone || undefined } }) : undefined}
                    />
                  </Field>
                  <Field label="Message">
                    <TextBox
                      value={def.schedule.message ?? ""}
                      placeholder="Scheduled check-in."
                      ariaLabel="Schedule message"
                      onChange={update ? (message) => update({ ...def, schedule: { ...def.schedule!, message: message || undefined } }) : undefined}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          </ListGroup>
        </Section>
      ) : null}

      {/* ---------- limits ---------- */}
      {full ? (
        <Section id="limits">
          <SectionHeading>Limits</SectionHeading>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Time per session" changed={changed(def.limits.session_minutes, saved?.limits.session_minutes)} hint="Agent work time. Waiting on people doesn't count.">
              <NumberField
                value={def.limits.session_minutes}
                min={1}
                max={1440}
                suffix="min"
                ariaLabel="Time per session"
                changed={changed(def.limits.session_minutes, saved?.limits.session_minutes)}
                onChange={update ? (value) => update({ ...def, limits: { ...def.limits, session_minutes: value ?? 0 } }) : undefined}
              />
              <FieldMessages {...at("limits.session_minutes")} />
            </Field>
            <Field label="Model turns per session" changed={changed(def.limits.max_turns, saved?.limits.max_turns)}>
              <NumberField
                value={def.limits.max_turns}
                min={1}
                max={1000}
                ariaLabel="Model turns per session"
                changed={changed(def.limits.max_turns, saved?.limits.max_turns)}
                onChange={update ? (value) => update({ ...def, limits: { ...def.limits, max_turns: value ?? 0 } }) : undefined}
              />
              <FieldMessages {...at("limits.max_turns")} />
            </Field>
            <Field
              label="Cost per session"
              changed={changed(def.limits.cost_usd, saved?.limits.cost_usd)}
              hint={markChanges && saved && def.limits.cost_usd !== saved.limits.cost_usd ? `Was ${saved.limits.cost_usd === null ? "unlimited" : `$${saved.limits.cost_usd}`}.` : "Leave empty for no limit."}
              hintTone={markChanges && saved && def.limits.cost_usd !== saved.limits.cost_usd ? "changed" : "muted"}
            >
              <NumberField
                value={def.limits.cost_usd}
                min={0}
                step={0.01}
                suffix="USD"
                placeholder="Unlimited"
                ariaLabel="Cost per session"
                changed={changed(def.limits.cost_usd, saved?.limits.cost_usd)}
                onChange={update ? (value) => update({ ...def, limits: { ...def.limits, cost_usd: value } }) : undefined}
              />
              <FieldMessages {...at("limits.cost_usd")} />
            </Field>
            <Field
              label="Always on"
              changed={changed(def.limits.always_on, saved?.limits.always_on)}
              hint="One conversation that never ends by time or turns, for a channel like iMessage. It carries on after a failure or restart. The cost limit then counts per day."
            >
              <Toggle on={def.limits.always_on} onChange={update ? (always_on) => update({ ...def, limits: { ...def.limits, always_on } }) : undefined} label="Always on" />
            </Field>
            <Field label="Long conversations" changed={changed(def.limits.long_context, saved?.limits.long_context)}>
              <SelectField
                value={def.limits.long_context}
                ariaLabel="Long conversations"
                options={[
                  { value: "summarize", label: "Summarize older turns when context fills" },
                  { value: "truncate", label: "Drop the oldest turns when context fills" },
                ]}
                onChange={update ? (long_context) => update({ ...def, limits: { ...def.limits, long_context } }) : undefined}
              />
            </Field>
          </div>
        </Section>
      ) : null}

      {/* ---------- version history ---------- */}
      {full && versions ? (
        <Section id="versions">
          <SectionHeading>Version history</SectionHeading>
          <ListGroup>
            {versions.revisions.map((row) => {
              const current = row.revision === versions.current;
              return (
                <div key={row.revision} className="flex items-center justify-between gap-4 px-3.5 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`${MONO} shrink-0 rounded-md px-1.5 py-0.5 text-[11px] leading-normal ${
                        current ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"
                      }`}
                    >
                      {current ? `v${row.revision} · current` : `v${row.revision}`}
                    </span>
                    <span className={`truncate text-[13px] leading-normal ${current ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>
                      {row.summary ?? SOURCE_LABEL[row.source]}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={`text-xs leading-[1.33333] text-[var(--sf-text-3)] ${NOWRAP}`}>
                      {[row.author, SOURCE_LABEL[row.source], formatWhen(row.createdAt)].filter(Boolean).join(" · ")}
                    </span>
                    {current ? null : (
                      <>
                        <LinkButton onClick={() => versions.onCompare(row.revision)}>Compare</LinkButton>
                        {editable ? (
                          <LinkButton onClick={() => versions.onRestore(row.revision)}>
                            <LuRotateCcw aria-hidden className="size-3" />
                            Restore
                          </LinkButton>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </ListGroup>
        </Section>
      ) : null}
    </div>
  );
}

function AgentMemoriesField({
  definition,
  onChange,
}: {
  definition: AgentDefinition;
  onChange?: (next: AgentDefinition) => void;
}) {
  const [available, setAvailable] = useState<MemorySummary[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetchMemories().then(
      (body) => { if (live) setAvailable(body.memories); },
      () => { if (live) setAvailable([]); },
    );
    return () => { live = false; };
  }, []);
  const selected = definition.memories ?? [];
  function toggle(id: string) {
    if (!onChange) return;
    const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
    onChange({ ...definition, memories: next.length > 0 ? next : undefined });
  }
  return (
    <div className="flex flex-col gap-2" data-testid="agent-memories">
      <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Memories</span>
      <Note>Every session of this agent can read and replace these pages.</Note>
      {available && available.length === 0 ? (
        <Note>
          No memories yet.{" "}
          <a href="#/memories" className="text-[var(--sf-text-1)] underline-offset-2 hover:underline">Create one from Memories</a>.
        </Note>
      ) : null}
      <ul className="flex flex-col gap-1">
        {(available ?? []).map((item) => (
          <li key={item.id}>
            <label className="flex items-start gap-2 text-xs text-[var(--sf-text-1)]">
              <input type="checkbox" checked={selected.includes(item.id)} disabled={!onChange} onChange={() => toggle(item.id)} />
              <span>
                <span className={MONO}>{item.id}</span>
                <span className="mt-0.5 block text-[var(--sf-text-3)]">{item.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
