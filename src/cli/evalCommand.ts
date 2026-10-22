import { stat } from "node:fs/promises";
import path from "node:path";
import {
  buildValidationResult,
  type ValidationFinding,
  type ValidationResult,
} from "../config/validateCatalog.js";
import { loadEvalCatalog } from "../config/evalCatalog.js";
import { evalStem, findEvalFile, manifestForWrite } from "../config/evalWriteRoots.js";
import { loadEvalOutcome } from "../config/loadEval.js";
import { EngineError } from "../evals/engine/promptfoo/errors.js";
import { installPromptfoo, type RunNpm } from "../evals/engine/promptfoo/install.js";
import { engineStatus } from "../evals/engine/promptfoo/status.js";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  ensureGlobalService,
  hostBaseUrl,
  type EnsureGlobalServiceResult,
} from "../server/ensureGlobalService.js";
import {
  httpCancelEvalRun,
  httpCompareEvalRuns,
  httpDeleteEvalRun,
  httpEnsureProject,
  httpGetEval,
  httpGetEvalRun,
  httpListDatasets,
  httpListEvalRuns,
  httpListEvals,
  httpStartEvalRun,
  type HttpEvalResult,
  type HttpStartEvalRunInput,
} from "./hostClient.js";
import { resolveCliProjectRootLocal } from "./resolveCliProjectRoot.js";
import {
  exitCodeForValidation,
  formatValidationHuman,
  formatValidationJson,
} from "./validateOutput.js";

export const EVAL_USAGE = `Usage:
  sf eval list [--json]
  sf eval show <id|path> [--json]
  sf eval validate [<id|path>] [--json] [--strict]
  sf eval run <id|path> [--repeats <n>] [--judge <model>] [--model <id>] [--user-model <model>] [--allow-real-tools] [--max-cost <usd>] [--case <id> ...] [--tag <tag> ...] [--label <text>] [--no-wait] [--json]
  sf eval runs [<evalId>] [--json]
  sf eval runs show <evalRunId> [--json]
  sf eval runs cancel <evalRunId>
  sf eval runs delete <evalRunId>
  sf eval compare <evalRunIdA> <evalRunIdB> [--json]
  sf eval datasets [--json]
  sf eval engine status [--json]
  sf eval engine install

  Agent evals: --model overrides the agent's model, --user-model the model that plays the user. An eval whose
  conversation.tools is real also needs --allow-real-tools.

  Every subcommand also accepts --project-root <id-or-path>.`;

export type EvalCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: EvalCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type EvalCommandOptions = {
  cwd?: string;
  projectRoot?: string;
  io?: Partial<EvalCommandIo>;
  hostBaseUrl?: string;
  ensureService?: () => Promise<EnsureGlobalServiceResult>;
  home?: string;
  runNpm?: RunNpm;
  pollIntervalMs?: number;
  stderrIsTTY?: boolean;
  onInterrupt?: (handler: () => void) => () => void;
};

type FlagSpec = { value?: boolean; repeat?: boolean };

const COMMON_FLAGS: Record<string, FlagSpec> = {
  "--json": {},
  "--help": {},
  "-h": {},
  "--project-root": { value: true },
};

const FLAGS: Record<string, Record<string, FlagSpec>> = {
  list: {},
  show: {},
  validate: { "--strict": {} },
  run: {
    "--repeats": { value: true },
    "--judge": { value: true },
    "--model": { value: true },
    "--user-model": { value: true },
    "--allow-real-tools": {},
    "--max-cost": { value: true },
    "--case": { value: true, repeat: true },
    "--tag": { value: true, repeat: true },
    "--label": { value: true },
    "--no-wait": {},
  },
  runs: {},
  compare: {},
  datasets: {},
  engine: {},
};

type Parsed = {
  help: boolean;
  json: boolean;
  strict: boolean;
  noWait: boolean;
  allowRealTools: boolean;
  userModel?: string;
  projectRoot?: string;
  repeats?: number;
  judge?: string;
  model?: string;
  maxCost?: number;
  label?: string;
  cases: string[];
  tags: string[];
  positionals: string[];
};

class UsageError extends Error {}

function parseArgs(command: string, rest: string[]): Parsed {
  const specs = { ...COMMON_FLAGS, ...FLAGS[command] };
  const parsed: Parsed = {
    help: false,
    json: false,
    strict: false,
    noWait: false,
    allowRealTools: false,
    cases: [],
    tags: [],
    positionals: [],
  };
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
      continue;
    }
    const spec = specs[arg];
    if (spec === undefined) throw new UsageError(`Unknown flag: ${arg}`);
    if (seen.has(arg) && spec.repeat !== true) throw new UsageError(`Duplicate flag: ${arg}`);
    seen.add(arg);
    let value: string | undefined;
    if (spec.value === true) {
      value = rest[++i];
      if (value === undefined || value.length === 0) throw new UsageError(`Missing value for ${arg}`);
    }
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--strict":
        parsed.strict = true;
        break;
      case "--no-wait":
        parsed.noWait = true;
        break;
      case "--allow-real-tools":
        parsed.allowRealTools = true;
        break;
      case "--user-model":
        parsed.userModel = value;
        break;
      case "--project-root":
        parsed.projectRoot = value;
        break;
      case "--judge":
        parsed.judge = value;
        break;
      case "--model":
        parsed.model = value;
        break;
      case "--label":
        parsed.label = value;
        break;
      case "--case":
        parsed.cases.push(value!);
        break;
      case "--tag":
        parsed.tags.push(value!);
        break;
      case "--repeats": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new UsageError("--repeats must be a positive integer");
        parsed.repeats = n;
        break;
      }
      case "--max-cost": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError("--max-cost must be a positive number");
        parsed.maxCost = n;
        break;
      }
    }
  }
  if (parsed.cases.length > 0 && parsed.tags.length > 0) {
    throw new UsageError("Use either --case or --tag, not both");
  }
  return parsed;
}

function looksLikePath(ref: string): boolean {
  return /[\\/]/.test(ref) || /\.ya?ml$/.test(ref);
}

function pct(value: number | null | undefined): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function usd(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "n/a";
}

type AgentTarget = { agent_id?: unknown; id?: unknown; revision?: unknown };

function agentLabel(target: AgentTarget): string {
  const id = String(target.agent_id ?? target.id ?? "");
  return typeof target.revision === "number" ? `Agent ${id} r${target.revision}` : `Agent ${id}`;
}

function targetLabel(target: Record<string, any> | undefined): string {
  if (target?.kind === "agent") return agentLabel(target);
  return target?.label ?? "";
}

function conversationLine(conversation: Record<string, any> | undefined): string | null {
  if (!conversation) return null;
  return `Conversation: ${conversation.mode ?? "script"}, up to ${conversation.max_turns ?? "?"} turns, tools ${conversation.tools ?? "read_only"}, approvals ${conversation.approvals ?? "record_only"}`;
}

const REAL_TOOLS_WARNING = "Warning: real tools can change files and call services from this machine.";

type RunOutcome = "passed" | "below_threshold" | "failed" | "cancelled" | "budget_stopped";

function outcomeOf(detail: { status: string; passed: boolean | null }): RunOutcome {
  if (detail.status === "completed") return detail.passed === true ? "passed" : "below_threshold";
  if (detail.status === "cancelled") return "cancelled";
  if (detail.status === "budget_stopped") return "budget_stopped";
  return "failed";
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_stopped"]);

export async function runEvalCommand(
  args: string[],
  options: EvalCommandOptions = {},
): Promise<number> {
  const out: EvalCommandIo = { ...defaultIo, ...options.io };
  const cwd = options.cwd ?? process.cwd();
  const base = options.hostBaseUrl ?? hostBaseUrl();
  const ensureService = options.ensureService ?? (() => ensureGlobalService());

  const usageError = (message?: string): number => {
    if (message !== undefined) out.error(message);
    out.error(EVAL_USAGE);
    return 1;
  };

  if (args.length === 0) return usageError();
  if (args[0] === "--help" || args[0] === "-h") {
    out.error(EVAL_USAGE);
    return 0;
  }

  const command = args[0];
  if (!(command in FLAGS)) return usageError(`Unknown eval subcommand: ${command}`);

  let parsed: Parsed;
  try {
    parsed = parseArgs(command, args.slice(1));
  } catch (err) {
    if (err instanceof UsageError) return usageError(err.message);
    throw err;
  }
  if (parsed.help) {
    out.error(EVAL_USAGE);
    return 0;
  }
  const positionals = [...parsed.positionals];
  const json = parsed.json;

  const printJson = (payload: unknown): void => out.log(JSON.stringify(payload, null, 2));

  const fail = (failure: { reason: string; status?: number; code?: string }): number => {
    if (json) {
      printJson({
        error: failure.reason,
        ...(failure.code !== undefined ? { code: failure.code } : {}),
        ...(failure.status !== undefined ? { status: failure.status } : {}),
      });
    } else {
      out.error(failure.code !== undefined ? `${failure.code}: ${failure.reason}` : failure.reason);
    }
    return 1;
  };

  let projectRoot = options.projectRoot ?? cwd;
  if (parsed.projectRoot !== undefined) {
    const local = resolveCliProjectRootLocal(parsed.projectRoot);
    if (!local) return usageError(`Unknown project_root: ${parsed.projectRoot.trim()}`);
    projectRoot = local.rootPath;
  }

  const expectArgs = (min: number, max: number, label: string): string | null => {
    if (positionals.length < min) return `Missing ${label}`;
    if (positionals.length > max) return `Unexpected argument: ${positionals[max]}`;
    return null;
  };

  const resolveEvalFile = async (
    ref: string,
    local = false,
  ): Promise<{ id: string; absPath?: string } | string> => {
    if (looksLikePath(ref)) {
      const absPath = path.resolve(cwd, ref);
      try {
        if (!(await stat(absPath)).isFile()) return `Not a file: ${ref}`;
      } catch {
        return `Eval file not found: ${ref}`;
      }
      const outcome = await loadEvalOutcome(absPath, projectRoot);
      return { id: outcome.ok ? outcome.value.id : evalStem(path.basename(absPath)), absPath };
    }
    if (!local) return { id: ref };
    const found = await findEvalFile(projectRoot, ref);
    if (found === undefined) return `Eval not found: ${ref}`;
    return { id: ref, absPath: found.absPath };
  };

  if (command === "engine") {
    const sub = positionals.shift();
    const home = options.home ?? globalStageflowHome();
    if (sub === "status") {
      const extra = expectArgs(0, 0, "");
      if (extra) return usageError(extra);
      const status = engineStatus({ home });
      const wire = {
        installed: status.installed,
        version: status.version,
        pinned: status.pinned,
        node: status.node,
        node_ok: status.nodeOk,
        install_command: status.installCommand,
      };
      if (json) printJson(wire);
      else {
        out.log(
          status.installed
            ? `Eval engine: promptfoo ${status.version} installed (pinned ${status.pinned})`
            : `Eval engine: not installed (pinned ${status.pinned}). Run \`${status.installCommand}\``,
        );
        out.log(`Node ${status.node}${status.nodeOk ? "" : " (too old for evals)"}`);
      }
      return 0;
    }
    if (sub === "install") {
      const extra = expectArgs(0, 0, "");
      if (extra) return usageError(extra);
      if (json) return usageError("Unknown flag: --json");
      try {
        const result = await installPromptfoo({
          home,
          ...(options.runNpm !== undefined ? { runNpm: options.runNpm } : {}),
          log: (line) => out.error(line),
        });
        out.log(
          result.status === "installed"
            ? `Installed promptfoo ${result.version}`
            : `promptfoo ${result.version} is already installed`,
        );
        return 0;
      } catch (err) {
        if (err instanceof EngineError) {
          out.error(`${err.code}: ${err.message}`);
          return 1;
        }
        out.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }
    return usageError(sub === undefined ? "Missing engine subcommand" : `Unknown engine subcommand: ${sub}`);
  }

  if (command === "validate") {
    const extra = expectArgs(0, 1, "");
    if (extra) return usageError(extra);
    let findings: ValidationFinding[];
    try {
      const manifest = await manifestForWrite(projectRoot);
      const entries = await loadEvalCatalog(manifest);
      if (positionals.length === 1) {
        const target = await resolveEvalFile(positionals[0], true);
        if (typeof target === "string") {
          out.error(target);
          return 1;
        }
        const entry = entries.find((e) => path.resolve(e.absPath) === path.resolve(target.absPath!));
        if (entry === undefined) {
          out.error(`Eval is not in a catalog root: ${positionals[0]}`);
          return 1;
        }
        findings = entry.findings;
      } else {
        findings = entries.flatMap((e) => e.findings);
      }
    } catch (err) {
      out.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    const result: ValidationResult = buildValidationResult("full", findings, parsed.strict);
    out.log(
      json ? formatValidationJson(result) : formatValidationHuman(result, { strict: parsed.strict }),
    );
    return exitCodeForValidation(result);
  }

  const argError =
    command === "list" || command === "datasets"
      ? expectArgs(0, 0, "")
      : command === "show"
        ? expectArgs(1, 1, "<id|path>")
        : command === "run"
          ? expectArgs(1, 1, "<id|path>")
          : command === "compare"
            ? expectArgs(2, 2, "<evalRunIdA> <evalRunIdB>")
            : null;
  if (argError) return usageError(argError);

  let runsSub: string | undefined;
  if (command === "runs") {
    if (["show", "cancel", "delete"].includes(positionals[0] ?? "")) {
      runsSub = positionals.shift();
      const err = expectArgs(1, 1, "<evalRunId>");
      if (err) return usageError(err);
    } else {
      const err = expectArgs(0, 1, "");
      if (err) return usageError(err);
    }
    if (json && (runsSub === "cancel" || runsSub === "delete")) return usageError("Unknown flag: --json");
  }

  const ensured = await ensureService();
  if (!ensured.ok) {
    if (json) printJson({ error: ensured.message, reason: ensured.reason });
    else out.error(ensured.message);
    return 1;
  }

  const project = await httpEnsureProject(base, projectRoot);
  if (!project.ok) return fail(project);
  const wireRoot = project.project_root;

  const show = <T>(result: HttpEvalResult<T>, human: (body: T) => void): number => {
    if (!result.ok) return fail(result);
    if (json) printJson(result.body);
    else human(result.body);
    return 0;
  };

  switch (command) {
    case "list":
      return show(await httpListEvals(base, wireRoot), (body) => {
        const items = (body.items ?? []) as Array<Record<string, any>>;
        for (const item of items) {
          out.log(
            [
              item.id,
              item.status,
              item.valid === false ? "invalid" : "valid",
              item.last_run ? pct(item.last_run.pass_rate) : "-",
              targetLabel(item.target),
            ].join("\t"),
          );
        }
      });

    case "show": {
      const target = await resolveEvalFile(positionals[0]);
      if (typeof target === "string") return fail({ reason: target, code: "EVAL_NOT_FOUND" });
      return show(await httpGetEval(base, target.id, wireRoot), (body) => {
        const detail = body as { yaml?: unknown; agent?: Record<string, any> | null; definition?: Record<string, any> | null };
        if (detail.definition?.target?.kind === "agent") {
          const live = detail.agent;
          out.log(
            live
              ? `${agentLabel({ id: live.id, revision: live.revision })}${live.model ? ` (${live.model})` : ""}`
              : agentLabel({ id: detail.definition.target.agent }),
          );
          const line = conversationLine({
            mode: detail.definition.conversation?.mode,
            max_turns: detail.definition.conversation?.max_turns,
            tools: detail.definition.conversation?.tools,
            approvals: detail.definition.conversation?.approvals,
          });
          if (line) out.log(line);
          out.log("");
        }
        out.log(String(detail.yaml ?? ""));
      });
    }

    case "datasets":
      return show(await httpListDatasets(base, wireRoot), (body) => {
        for (const item of body.items as Array<Record<string, any>>) {
          out.log([item.id, item.format, item.cases, item.path].join("\t"));
        }
      });

    case "compare":
      return show(await httpCompareEvalRuns(base, positionals[0], positionals[1]), (body) => {
        out.log(JSON.stringify(body, null, 2));
      });

    case "runs": {
      if (runsSub === "show") {
        return show(await httpGetEvalRun(base, positionals[0]), (d) => {
          out.log(`${d.eval_id} run #${d.run_number}\t${d.status}\t${d.eval_run_id}`);
          if (d.status_reason) out.log(`reason: ${d.status_reason}`);
          out.log(
            `pass rate ${pct(d.stats?.pass_rate)}\tresults ${d.progress?.results_done}/${d.progress?.results_total}\tcost ${usd(d.stats?.cost_total ?? d.progress?.cost_usd)}`,
          );
          if (d.config?.target?.agent_id !== undefined) {
            out.log(agentLabel(d.config.target));
            const line = conversationLine(d.config.settings?.conversation);
            if (line) out.log(line);
            out.log(
              `mean turns ${d.stats?.mean_turns ?? "n/a"}\tmean tool calls ${d.stats?.mean_tool_calls ?? "n/a"}`,
            );
          }
          out.log(`fingerprint ${d.fingerprint}`);
        });
      }
      if (runsSub === "cancel") {
        const result = await httpCancelEvalRun(base, positionals[0]);
        if (!result.ok) return fail(result);
        out.log(`Eval run ${result.body.eval_run_id} ${result.body.status}`);
        return 0;
      }
      if (runsSub === "delete") {
        const result = await httpDeleteEvalRun(base, positionals[0]);
        if (!result.ok) return fail(result);
        out.log(`Deleted eval run ${positionals[0]}`);
        return 0;
      }
      return show(
        await httpListEvalRuns(base, {
          project_root: wireRoot,
          ...(positionals[0] !== undefined ? { eval_id: positionals[0] } : {}),
        }),
        (body) => {
          for (const item of body.items as Array<Record<string, any>>) {
            out.log(
              [
                item.eval_id,
                `#${item.run_number}`,
                item.status,
                pct(item.pass_rate),
                usd(item.cost_total),
                item.eval_run_id,
              ].join("\t"),
            );
          }
        },
      );
    }

    case "run":
      return runEval();

    default:
      return usageError(`Unknown eval subcommand: ${command}`);
  }

  async function runEval(): Promise<number> {
    const target = await resolveEvalFile(positionals[0]);
    if (typeof target === "string") return fail({ reason: target, code: "EVAL_NOT_FOUND" });

    const input: HttpStartEvalRunInput = {
      project_root: wireRoot,
      started_via: "cli",
      ...(parsed.repeats !== undefined ? { repeats: parsed.repeats } : {}),
      ...(parsed.judge !== undefined ? { judge: parsed.judge } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.userModel !== undefined ? { user_model: parsed.userModel } : {}),
      ...(parsed.allowRealTools ? { allow_real_tools: true } : {}),
      ...(parsed.maxCost !== undefined ? { max_cost_usd: parsed.maxCost } : {}),
      ...(parsed.cases.length > 0 ? { case_ids: parsed.cases } : {}),
      ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
      ...(parsed.label !== undefined ? { label: parsed.label } : {}),
    };
    if (parsed.allowRealTools) {
      const detail = await httpGetEval(base, target.id, wireRoot);
      const definition = detail.ok ? (detail.body as { definition?: Record<string, any> | null }).definition : null;
      if (definition?.target?.kind === "agent" && definition.conversation?.tools === "real") {
        out.error(REAL_TOOLS_WARNING);
      }
    }
    const started = await httpStartEvalRun(base, target.id, input);
    if (!started.ok) {
      if (started.code === "EVAL_REAL_TOOLS_NOT_CONFIRMED") {
        if (json) printJson({ ok: false, code: started.code, message: started.reason });
        else out.error(`${started.code}: ${started.reason} Re-run with --allow-real-tools to confirm.`);
        return 1;
      }
      if (started.code === "EVAL_INVALID" && started.findings !== undefined) {
        const result = buildValidationResult("full", started.findings as ValidationFinding[], false);
        out.log(json ? formatValidationJson(result) : formatValidationHuman(result));
        return 1;
      }
      return fail(started);
    }
    const evalRunId = started.body.eval_run_id;

    if (parsed.noWait) {
      if (json) printJson({ eval_run_id: evalRunId, status: started.body.status });
      else out.log(evalRunId);
      return 0;
    }

    let interrupted = false;
    let wake: () => void = () => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const subscribe =
      options.onInterrupt ??
      ((handler: () => void) => {
        process.once("SIGINT", handler);
        return () => process.removeListener("SIGINT", handler);
      });
    const unsubscribe = subscribe(() => {
      interrupted = true;
      wake();
    });

    const interval = options.pollIntervalMs ?? 1500;
    const tty = options.stderrIsTTY ?? process.stderr.isTTY === true;
    let lastProgress = "";
    let detail: Record<string, any> | undefined;
    try {
      for (;;) {
        if (interrupted) {
          const cancelled = await httpCancelEvalRun(base, evalRunId);
          if (!cancelled.ok) {
            fail(cancelled);
            return 1;
          }
          detail = cancelled.body;
          break;
        }
        const polled = await httpGetEvalRun(base, evalRunId);
        if (!polled.ok) return fail(polled);
        detail = polled.body;
        if (TERMINAL.has(detail.status)) break;
        if (tty) {
          const line = `${detail.progress?.results_done ?? 0}/${detail.progress?.results_total ?? 0} results, ${usd(detail.progress?.cost_usd ?? 0)}`;
          if (line !== lastProgress) {
            lastProgress = line;
            out.error(line);
          }
        }
        await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, interval)), woken]);
      }
    } finally {
      unsubscribe();
    }

    return reportRun(detail!);
  }

  function reportRun(detail: Record<string, any>): number {
    const outcome = outcomeOf(detail as { status: string; passed: boolean | null });
    const stats = detail.stats as Record<string, any> | null;
    const threshold = detail.config?.settings?.pass_threshold ?? detail.components?.pass_threshold ?? null;
    const doc = {
      outcome,
      eval_run_id: detail.eval_run_id as string,
      eval_id: detail.eval_id as string,
      pass_rate: stats?.pass_rate ?? null,
      pass_rate_ci: stats?.pass_rate_ci ?? null,
      threshold,
      results: {
        executed: stats?.results_executed ?? 0,
        passed: stats?.results_passed ?? 0,
        errored: stats?.errored ?? 0,
      },
      reliability: stats?.reliability ?? null,
      cost_total: stats?.cost_total ?? detail.progress?.cost_usd ?? 0,
      fingerprint: detail.fingerprint as string,
      url: `${base}/#/evals/${detail.eval_id}/runs/${detail.run_number}`,
      ...(detail.config?.target?.agent_id !== undefined
        ? {
            target_kind: "agent" as const,
            agent_id: detail.config.target.agent_id as string,
            agent_revision: (detail.config.target.revision ?? null) as number | null,
            mean_turns: (stats?.mean_turns ?? null) as number | null,
            mean_tool_calls: (stats?.mean_tool_calls ?? null) as number | null,
            tools_policy: (detail.config.settings?.conversation?.tools ?? null) as string | null,
          }
        : {}),
    };
    if (json) {
      printJson(doc);
    } else {
      const ci = doc.pass_rate_ci
        ? ` (CI ${pct(doc.pass_rate_ci.low)} to ${pct(doc.pass_rate_ci.high)})`
        : "";
      out.log(`Eval ${doc.eval_id} run #${detail.run_number}: ${outcome.replace("_", " ").toUpperCase()}`);
      if (detail.status_reason) out.log(`Reason: ${detail.status_reason}`);
      out.log(`Pass rate: ${pct(doc.pass_rate)}${ci}, threshold ${pct(threshold)}`);
      out.log(
        `Results: ${doc.results.executed} executed, ${doc.results.passed} passed, ${doc.results.errored} errored`,
      );
      out.log(`Reliability: ${doc.reliability ?? "n/a"}`);
      if (doc.target_kind === "agent") {
        out.log(`${agentLabel({ id: doc.agent_id, revision: doc.agent_revision })}, tools ${doc.tools_policy ?? "n/a"}`);
        out.log(`Mean turns: ${doc.mean_turns ?? "n/a"}, mean tool calls: ${doc.mean_tool_calls ?? "n/a"}`);
      }
      out.log(`Cost: ${usd(doc.cost_total)}`);
      out.log(`Fingerprint: ${doc.fingerprint}`);
      out.log(`URL: ${doc.url}`);
    }
    return outcome === "passed" ? 0 : 1;
  }
}
