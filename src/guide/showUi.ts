import path from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import { isAgentError } from "../agents/errors.js";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import { loadDraftPackage, loadTaskArtifact, validateDraftPackage, type DraftPackage } from "../config/draftPackage.js";
import { listTasksMultiProject } from "../config/multiProjectCatalog.js";
import { loadCatalogTriggers } from "../config/triggerCatalog.js";
import { MemoryError } from "../memory/host.js";
import type { McpToolDeps } from "../mcp/deps.js";
import { buildEvalDetail, buildResultsPage, EvalApiError, locateEval, runByIdOr404 } from "../evals/read/api.js";
import { buildRunDetail } from "../evals/read/runs.js";
import type { OperatorAgentTool, OperatorAgentToolResult } from "../operatorAgent/types.js";

export const GUIDE_UI_TOOL_NAMES = ["show_ui"] as const;

export const GUIDE_LINK_KINDS = [
  "pipeline",
  "stage",
  "task",
  "agent",
  "trigger",
  "eval",
  "eval_run",
  "dataset",
  "connection",
  "memory",
  "run",
] as const;

export const GUIDE_RESOURCE_KINDS = ["agent", "trigger", "eval", "connection", "memory", "task"] as const;

const MAX_TEXT = 300;
const MAX_PLAN_STEPS = 12;
const MAX_CHOICES = 6;
const MAX_LINKS = 8;
const MAX_FAILURES = 5;
const MAX_MESSAGES = 5;

export type GuideLinkKind = (typeof GUIDE_LINK_KINDS)[number];

export type GuideLink = { kind: GuideLinkKind; id: string; path?: string; projectRoot?: string; label?: string };

export type GuidePipelineStage = {
  id: string;
  summary?: string;
  model?: string;
  needs: string[];
  gates: string[];
  channels: string[];
  hasVerify: boolean;
};

export type GuideUi =
  | {
      component: "pipeline";
      title: string;
      pipeline: {
        id: string;
        path: string;
        model?: string;
        stages: GuidePipelineStage[];
        memories: string[];
        task?: { id: string; goal: string };
      };
      validation: { ok: boolean; errors: number; warnings: number; messages: string[] };
      link: GuideLink;
    }
  | {
      component: "resource";
      title: string;
      kind: GuideLinkKind;
      fields: Array<{ label: string; value: string }>;
      status?: string;
      link: GuideLink;
    }
  | { component: "plan"; title: string; steps: Array<{ title: string; detail?: string; status: "todo" | "current" | "done" }> }
  | { component: "choices"; question: string; options: Array<{ id: string; label: string; description?: string }>; allowOther: boolean }
  | {
      component: "eval_report";
      title: string;
      evalId: string;
      runId: string;
      status: string;
      passRate: number | null;
      passed: boolean | null;
      cases: number;
      failures: Array<{ caseId: string; reason: string }>;
      costUsd: number | null;
      link: GuideLink;
    }
  | { component: "links"; title?: string; links: GuideLink[] };

const text = z.string().trim().min(1).max(MAX_TEXT);
const ref = z.string().trim().min(1).max(MAX_TEXT);

const pipelineArgs = z.object({
  component: z.literal("pipeline"),
  path: ref,
  task_path: ref.optional(),
  title: text.optional(),
});

const resourceArgs = z.object({
  component: z.literal("resource"),
  kind: z.string(),
  id: ref,
  project_root: ref.optional(),
  title: text.optional(),
});

const planArgs = z.object({
  component: z.literal("plan"),
  title: text,
  steps: z
    .array(z.object({ title: text, detail: text.optional(), status: z.enum(["todo", "current", "done"]) }))
    .min(1)
    .max(MAX_PLAN_STEPS),
});

const choicesArgs = z.object({
  component: z.literal("choices"),
  question: text,
  options: z
    .array(z.object({ id: ref, label: text, description: text.optional() }))
    .min(1)
    .max(MAX_CHOICES),
  allow_other: z.boolean().optional(),
});

const evalReportArgs = z.object({
  component: z.literal("eval_report"),
  eval_run_id: ref,
});

const linkArg = z.object({
  kind: z.enum(GUIDE_LINK_KINDS),
  id: ref,
  path: ref.optional(),
  project_root: ref.optional(),
  label: text.optional(),
});

const linksArgs = z.object({
  component: z.literal("links"),
  title: text.optional(),
  links: z.array(linkArg).min(1).max(MAX_LINKS),
});

class GuideUiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): OperatorAgentToolResult {
  return { ok: false, content: { ok: false, error: code }, error: code };
}

function parseArgs<S extends z.ZodType>(schema: S, args: Record<string, unknown>): z.output<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new GuideUiError("guide.ui_invalid_args");
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stemOf(uses: string): string {
  return path.posix.basename(uses).replace(/(\.stage)?\.ya?ml$/i, "");
}

function channelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = str(entry.alias) ?? str(entry.connection);
    if (name) names.push(name);
  }
  return names;
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function pipelineStages(draft: DraftPackage): GuidePipelineStage[] {
  const files = new Map((draft.stages ?? []).map((stage) => [stage.path.trim().replace(/\\/g, "/"), stage.body]));
  const stages = draft.pipeline.stages.map((entry) => {
    const uses = str(entry.uses)?.replace(/\\/g, "/");
    const body = uses ? (files.get(uses) ?? {}) : entry;
    const id = str(entry.id) ?? str(body.id) ?? (uses ? stemOf(uses) : "");
    const prompt = str(body.system_prompt)?.split("\n")[0]?.trim();
    const model = str(body.model);
    const channels = body.channels !== undefined ? body.channels : draft.pipeline.channels;
    return {
      id,
      ...(prompt ? { summary: clip(prompt) } : {}),
      ...(model ? { model } : {}),
      needs: [] as string[],
      gates: stringList(body.gate_kinds),
      channels: channelNames(channels),
      hasVerify: hasEntries(body.verify) || hasEntries(body.pre_emit_checks) || hasEntries(body.completion),
      route: Array.isArray(entry.route) ? entry.route : [],
    };
  });
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  for (const stage of stages) {
    for (const edge of stage.route) {
      if (!isRecord(edge) || edge.type === "loop") continue;
      const target = byId.get(str(edge.to) ?? "");
      if (target && !target.needs.includes(stage.id)) target.needs.push(stage.id);
    }
  }
  return stages.map(({ route: _route, ...stage }) => stage);
}

async function pipelineUi(deps: McpToolDeps, args: Record<string, unknown>): Promise<GuideUi> {
  const input = parseArgs(pipelineArgs, args);
  const projectRoot = deps.projectRoot ?? deps.cwd;
  const loaded = await loadDraftPackage(projectRoot, input.path, input.task_path ? { taskPath: input.task_path } : {});
  if (!loaded.ok) throw new GuideUiError(loaded.status === 404 ? "guide.ui_not_found" : "guide.ui_read_failed");
  const validation = await validateDraftPackage(loaded.draft, { cwd: deps.cwd, projectRoot });
  const { draft } = loaded;
  const model = str(draft.pipeline.model);
  const taskId = str(draft.task?.body.id);
  const taskGoal = str(draft.task?.body.goal);
  return {
    component: "pipeline",
    title: input.title ?? draft.pipeline.id,
    pipeline: {
      id: draft.pipeline.id,
      path: loaded.pipelinePath,
      ...(model ? { model } : {}),
      stages: pipelineStages(draft),
      memories: stringList(draft.pipeline.memories),
      ...(taskId && taskGoal ? { task: { id: taskId, goal: clip(taskGoal) } } : {}),
    },
    validation: {
      ok: validation.ok,
      errors: validation.summary.errors,
      warnings: validation.summary.warnings,
      messages: validation.findings.slice(0, MAX_MESSAGES).map((finding) => clip(finding.message)),
    },
    link: { kind: "pipeline", id: draft.pipeline.id, path: loaded.pipelinePath, projectRoot },
  };
}

type Field = { label: string; value: string };

function fields(entries: Array<[string, unknown]>): Field[] {
  const out: Field[] = [];
  for (const [label, value] of entries) {
    if (value === undefined || value === null) continue;
    const shown = Array.isArray(value) ? value.join(", ") : String(value);
    if (shown.trim()) out.push({ label, value: clip(shown) });
  }
  return out;
}

type ResourceUi = Extract<GuideUi, { component: "resource" }>;

async function agentResource(deps: McpToolDeps, id: string): Promise<Omit<ResourceUi, "component" | "title">> {
  if (!deps.agentService) throw new GuideUiError("guide.ui_unavailable");
  const { agent } = await deps.agentService.get(defaultAgentProjectRoot(deps.cwd), id);
  return {
    kind: "agent",
    fields: fields([
      ["Name", agent.name],
      ["Description", agent.description],
      ["Model", agent.model?.id ?? "default"],
      ["Revision", agent.revision],
      ["Tools", agent.tools.builtin],
      ["MCP servers", agent.tools.mcpServers],
      ["Skills", agent.tools.skills],
      ["Schedule", agent.scheduleCron],
      ["Channel", agent.channelConnection],
      ["Sub-agents", agent.subAgents],
    ]),
    status: agent.enabled ? "enabled" : "disabled",
    link: { kind: "agent", id: agent.id, label: agent.name },
  };
}

async function triggerResource(
  deps: McpToolDeps,
  id: string,
  projectRoot: string | undefined,
): Promise<Omit<ResourceUi, "component" | "title">> {
  const items = await loadCatalogTriggers({ store: deps.store, bootCwd: deps.cwd });
  const matches = items.filter((item) => item.id === id && (projectRoot === undefined || item.project_root === projectRoot));
  if (matches.length === 0) throw new GuideUiError("guide.ui_not_found");
  if (matches.length > 1) throw new GuideUiError("guide.ui_ambiguous");
  const trigger = matches[0]!;
  return {
    kind: "trigger",
    fields: fields([
      ["Pipeline", trigger.pipeline],
      ["Task", trigger.task],
      ["Kind", trigger.kind],
      ["Schedule", trigger.schedule ? [trigger.schedule.cron, trigger.schedule.timezone].filter(Boolean).join(" ") : undefined],
      ["Event", trigger.event?.source],
      ["Last fired", trigger.last_fired_at],
      ["Last run", trigger.last_run_id],
      ["Next run", trigger.next_run_at],
    ]),
    status: trigger.enabled ? "enabled" : "disabled",
    link: { kind: "trigger", id: trigger.id, path: trigger.definition_ref, projectRoot: trigger.project_root },
  };
}

async function evalResource(
  deps: McpToolDeps,
  id: string,
  projectRoot: string | undefined,
): Promise<Omit<ResourceUi, "component" | "title">> {
  const located = await locateEval({ store: deps.store, bootCwd: deps.cwd }, projectRoot, id);
  const detail = await buildEvalDetail({
    store: deps.store,
    projectRoot: located.projectRoot,
    absPath: located.ref.absPath,
    ...(deps.agentService !== undefined ? { agents: deps.agentService } : {}),
  });
  const errors = detail.findings.filter((finding) => finding.severity === "error").length;
  const last = detail.last_run;
  return {
    kind: "eval",
    fields: fields([
      ["Path", detail.path],
      ["Target model", detail.target_model],
      ["Judge", detail.judge_default],
      ["Runs", detail.runs_count],
      ["Last run", last ? `#${last.run_number} ${last.status}` : undefined],
      ["Last pass rate", typeof last?.pass_rate === "number" ? `${Math.round(last.pass_rate * 100)}%` : undefined],
      ["Problems", errors > 0 ? errors : undefined],
    ]),
    status: detail.active_run?.status ?? last?.status ?? "not run",
    link: { kind: "eval", id: detail.id, path: detail.path, projectRoot: located.projectRoot },
  };
}

function connectionResource(deps: McpToolDeps, id: string): Omit<ResourceUi, "component" | "title"> {
  if (!deps.channels) throw new GuideUiError("guide.ui_unavailable");
  const listing = deps.channels.list();
  const connection = listing.connections.find((item) => item.id === id);
  if (!connection) throw new GuideUiError(listing.error ? "guide.ui_read_failed" : "guide.ui_not_found");
  const health = connection.health;
  return {
    kind: "connection",
    fields: fields([
      ["Name", connection.displayName],
      ["Provider", connection.provider],
      ["Identity", connection.identity],
      ["Last check", health ? (health.state === "ok" ? "ok" : (health.error?.code ?? "failed")) : undefined],
    ]),
    status: connection.enabled ? (health?.state === "failed" ? "failing" : "enabled") : "disabled",
    link: { kind: "connection", id: connection.id, label: connection.displayName },
  };
}

async function memoryResource(deps: McpToolDeps, id: string): Promise<Omit<ResourceUi, "component" | "title">> {
  if (!deps.memories) throw new GuideUiError("guide.ui_unavailable");
  const meta = await deps.memories.readMeta(id);
  const cards = await deps.memories.listCards(id);
  return {
    kind: "memory",
    fields: fields([
      ["Description", meta.description],
      ["Cards", cards.length],
    ]),
    link: { kind: "memory", id: meta.id },
  };
}

async function taskResource(
  deps: McpToolDeps,
  id: string,
  projectRoot: string | undefined,
): Promise<Omit<ResourceUi, "component" | "title">> {
  if (/\.ya?ml$/i.test(id) || id.includes("/")) {
    const root = projectRoot ?? deps.projectRoot ?? deps.cwd;
    const loaded = await loadTaskArtifact(root, id);
    if (!loaded.ok) throw new GuideUiError(loaded.status === 404 ? "guide.ui_not_found" : "guide.ui_read_failed");
    const body = loaded.task.body;
    const taskId = str(body.id) ?? stemOf(loaded.taskPath).replace(/\.task$/, "");
    return {
      kind: "task",
      fields: fields([
        ["Goal", str(body.goal)],
        ["Context", str(body.context)],
        ["Constraints", str(body.constraints)],
        ["Checkout", str(body.checkout)],
        ["Repository", str(body.repository)],
        ["Ref", str(body.ref)],
        ["Path", loaded.taskPath],
      ]),
      link: { kind: "task", id: taskId, path: loaded.taskPath, projectRoot: root },
    };
  }
  const listed = await listTasksMultiProject({
    store: deps.store,
    bootCwd: deps.cwd,
    ...(projectRoot !== undefined ? { projectRootFilter: projectRoot } : {}),
  });
  const matches = listed.items.filter((item) => item.id === id);
  if (matches.length === 0) throw new GuideUiError("guide.ui_not_found");
  if (matches.length > 1) throw new GuideUiError("guide.ui_ambiguous");
  const task = matches[0]!;
  return {
    kind: "task",
    fields: fields([
      ["Goal", task.goal],
      ["Path", task.path],
    ]),
    link: { kind: "task", id: task.id, path: task.path, projectRoot: task.project_root },
  };
}

async function resourceUi(deps: McpToolDeps, args: Record<string, unknown>): Promise<GuideUi> {
  const input = parseArgs(resourceArgs, args);
  if (!(GUIDE_RESOURCE_KINDS as readonly string[]).includes(input.kind)) throw new GuideUiError("guide.ui_unsupported_kind");
  const kind = input.kind as (typeof GUIDE_RESOURCE_KINDS)[number];
  const read =
    kind === "agent"
      ? await agentResource(deps, input.id)
      : kind === "trigger"
        ? await triggerResource(deps, input.id, input.project_root)
        : kind === "eval"
          ? await evalResource(deps, input.id, input.project_root)
          : kind === "connection"
            ? connectionResource(deps, input.id)
            : kind === "memory"
              ? await memoryResource(deps, input.id)
              : await taskResource(deps, input.id, input.project_root);
  return { component: "resource", title: input.title ?? read.link.label ?? read.link.id, ...read };
}

async function evalReportUi(deps: McpToolDeps, args: Record<string, unknown>): Promise<GuideUi> {
  const input = parseArgs(evalReportArgs, args);
  const row = await runByIdOr404(deps.store, input.eval_run_id);
  const detail = await buildRunDetail({
    store: deps.store,
    row,
    live: deps.evalRunManager?.getLive(row.evalRunId) ?? null,
    ...(deps.agentService !== undefined ? { agents: deps.agentService } : {}),
  });
  const failures: Array<{ caseId: string; reason: string }> = [];
  for (const status of ["failed", "errored"] as const) {
    if (failures.length >= MAX_FAILURES) break;
    const page = await buildResultsPage(deps.store, row.evalRunId, { status, limit: MAX_FAILURES - failures.length });
    for (const item of page.items) {
      failures.push({
        caseId: item.case_id,
        reason: clip(item.failed_graders.length > 0 ? `Failed ${item.failed_graders.join(", ")}` : status),
      });
    }
  }
  return {
    component: "eval_report",
    title: detail.label ?? `${detail.eval_id} run #${detail.run_number}`,
    evalId: detail.eval_id,
    runId: detail.eval_run_id,
    status: detail.status,
    passRate: detail.stats?.pass_rate ?? null,
    passed: detail.passed,
    cases: detail.progress.cases_total,
    failures,
    costUsd: detail.stats?.cost_total ?? detail.progress.cost_usd,
    link: { kind: "eval_run", id: detail.eval_run_id, path: detail.eval_path },
  };
}

function jsonList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function normalizePlainArgs(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  for (const key of ["options", "steps", "links"] as const) {
    if (key in next) next[key] = jsonList(next[key]);
  }
  if (next.allow_other === "true") next.allow_other = true;
  if (next.allow_other === "false") next.allow_other = false;
  return next;
}

function plainUi(args: Record<string, unknown>, component: string): GuideUi {
  args = normalizePlainArgs(args);
  if (component === "plan") {
    const input = parseArgs(planArgs, args);
    return {
      component: "plan",
      title: input.title,
      steps: input.steps.map((step) => ({ title: step.title, ...(step.detail ? { detail: step.detail } : {}), status: step.status })),
    };
  }
  if (component === "choices") {
    const input = parseArgs(choicesArgs, args);
    return {
      component: "choices",
      question: input.question,
      options: input.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      allowOther: input.allow_other ?? false,
    };
  }
  const input = parseArgs(linksArgs, args);
  return {
    component: "links",
    ...(input.title ? { title: input.title } : {}),
    links: input.links.map((link) => ({
      kind: link.kind,
      id: link.id,
      ...(link.path ? { path: link.path } : {}),
      ...(link.project_root ? { projectRoot: link.project_root } : {}),
      ...(link.label ? { label: link.label } : {}),
    })),
  };
}

function errorCode(err: unknown): string {
  if (err instanceof GuideUiError) return err.code;
  if (err instanceof EvalApiError) return err.status === 404 ? "guide.ui_not_found" : err.status === 409 ? "guide.ui_ambiguous" : "guide.ui_read_failed";
  if (isAgentError(err) || err instanceof MemoryError) return /not_found/i.test(err.code) ? "guide.ui_not_found" : "guide.ui_read_failed";
  return "guide.ui_read_failed";
}

export async function buildGuideUi(deps: McpToolDeps, args: Record<string, unknown>): Promise<OperatorAgentToolResult> {
  const component = args.component;
  try {
    let ui: GuideUi;
    if (component === "pipeline") ui = await pipelineUi(deps, args);
    else if (component === "resource") ui = await resourceUi(deps, args);
    else if (component === "eval_report") ui = await evalReportUi(deps, args);
    else if (component === "plan" || component === "choices" || component === "links") ui = plainUi(args, component);
    else return fail("guide.ui_unknown_component");
    return { ok: true, content: { ui } };
  } catch (err) {
    return fail(errorCode(err));
  }
}

const DESCRIPTION = `Show a card in your reply. Pass component and its fields:
- pipeline: { component: "pipeline", path, task_path?, title? } shows a pipeline read from disk (path relative to the project root).
- resource: { component: "resource", kind: agent|trigger|eval|connection|memory|task, id, project_root?, title? } shows one saved thing. For a task, id is its path or its id.
- plan: { component: "plan", title, steps: [{ title, detail?, status: todo|current|done }] } (up to ${MAX_PLAN_STEPS} steps).
- choices: { component: "choices", question, options: [{ id, label, description? }], allow_other? } asks the person to pick (up to ${MAX_CHOICES} options). options, steps, and links are arrays of objects, never a JSON string.
- eval_report: { component: "eval_report", eval_run_id } shows an eval run's result.
- links: { component: "links", title?, links: [{ kind, id, path?, project_root?, label? }] } (up to ${MAX_LINKS}).
Text is at most ${MAX_TEXT} characters. The card shows what is on disk, so do not repeat it in prose.`;

const closed = { additionalProperties: false } as const;
const uiText = Type.String({ minLength: 1, maxLength: MAX_TEXT });

const showUiParameters = Type.Union([
  Type.Object(
    {
      component: Type.Literal("pipeline"),
      path: uiText,
      task_path: Type.Optional(uiText),
      title: Type.Optional(uiText),
    },
    closed,
  ),
  Type.Object(
    {
      component: Type.Literal("resource"),
      kind: Type.String({ minLength: 1 }),
      id: uiText,
      project_root: Type.Optional(uiText),
      title: Type.Optional(uiText),
    },
    closed,
  ),
  Type.Object(
    {
      component: Type.Literal("plan"),
      title: uiText,
      steps: Type.Array(
        Type.Object(
          {
            title: uiText,
            detail: Type.Optional(uiText),
            status: Type.Union([Type.Literal("todo"), Type.Literal("current"), Type.Literal("done")]),
          },
          closed,
        ),
        { minItems: 1, maxItems: MAX_PLAN_STEPS },
      ),
    },
    closed,
  ),
  Type.Object(
    {
      component: Type.Literal("choices"),
      question: uiText,
      options: Type.Array(
        Type.Object(
          {
            id: uiText,
            label: uiText,
            description: Type.Optional(uiText),
          },
          closed,
        ),
        { minItems: 1, maxItems: MAX_CHOICES },
      ),
      allow_other: Type.Optional(Type.Boolean()),
    },
    closed,
  ),
  Type.Object(
    {
      component: Type.Literal("eval_report"),
      eval_run_id: uiText,
    },
    closed,
  ),
  Type.Object(
    {
      component: Type.Literal("links"),
      title: Type.Optional(uiText),
      links: Type.Array(
        Type.Object(
          {
            kind: Type.Union(GUIDE_LINK_KINDS.map((kind) => Type.Literal(kind)) as [
              ReturnType<typeof Type.Literal>,
              ReturnType<typeof Type.Literal>,
              ...ReturnType<typeof Type.Literal>[],
            ]),
            id: uiText,
            path: Type.Optional(uiText),
            project_root: Type.Optional(uiText),
            label: Type.Optional(uiText),
          },
          closed,
        ),
        { minItems: 1, maxItems: MAX_LINKS },
      ),
    },
    closed,
  ),
]);

export function createShowUiTool(deps: McpToolDeps): OperatorAgentTool {
  return {
    name: "show_ui",
    description: DESCRIPTION,
    parameters: showUiParameters,
    handler: (args) => buildGuideUi(deps, args),
  };
}
