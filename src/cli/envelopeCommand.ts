import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildHandoffDeliverable,
  isHandoffSkipped,
  type HandoffResult,
} from "./handoffFormat.js";
import { createRunStore } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";

export const ENVELOPE_USAGE = `Usage:
  sf envelope get --run <runId> --stage <stageId> [--json] [--from <sf-run.json>] [--detect-stage <id>] [--format envelope|handoff]`;

export type EnvelopeCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: EnvelopeCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type EnvelopeOutput = StageEnvelope | SyntheticSkippedEnvelope;

export type SyntheticSkippedEnvelope = {
  status: "skipped";
  summary: "stage was fork-skipped";
  artifacts: [];
  fork_choice: null;
};

type EnvelopeFormat = "envelope" | "handoff";

type ParsedEnvelopeArgs = {
  help: boolean;
  subcommand?: string;
  runId?: string;
  stageId?: string;
  json: boolean;
  fromPath?: string;
  detectStageId?: string;
  format: EnvelopeFormat;
};

type RunContext = {
  runId: string;
  runDir: string;
};

export function parseEnvelopeArgs(args: string[]): ParsedEnvelopeArgs {
  if (args.length === 0) {
    return { help: false, json: false, format: "envelope" };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false, format: "envelope" };
  }

  const subcommand = args[0];
  if (subcommand !== "get") {
    throw new Error(`Unknown envelope subcommand: ${subcommand}`);
  }

  let runId: string | undefined;
  let stageId: string | undefined;
  let json = false;
  let fromPath: string | undefined;
  let detectStageId: string | undefined;
  let format: EnvelopeFormat = "envelope";
  let help = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--run") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --run");
      }
      runId = value;
    } else if (arg === "--stage") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --stage");
      }
      stageId = value;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--from") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --from");
      }
      fromPath = value;
    } else if (arg === "--detect-stage") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --detect-stage");
      }
      detectStageId = value;
    } else if (arg === "--format") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --format");
      }
      if (value !== "envelope" && value !== "handoff") {
        throw new Error(`Unknown --format value: ${value}`);
      }
      format = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help,
    subcommand,
    runId,
    stageId,
    json,
    fromPath,
    detectStageId,
    format,
  };
}

type SfRunDocument = {
  runId?: string;
  runDir?: string;
  outcome?: unknown;
  ok?: unknown;
};

function parseSfRunDocument(raw: string): SfRunDocument {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const doc = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse --from file JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("--from file must contain a JSON object with runId");
  }
  const record = parsed as {
    runId?: unknown;
    runDir?: unknown;
    outcome?: unknown;
    ok?: unknown;
  };
  const runId =
    typeof record.runId === "string" && record.runId.length > 0
      ? record.runId
      : undefined;
  const runDir =
    typeof record.runDir === "string" && record.runDir.length > 0
      ? record.runDir
      : undefined;
  return { runId, runDir, outcome: record.outcome, ok: record.ok };
}

function assertSfRunSucceededForHandoff(doc: SfRunDocument): void {
  if (doc.outcome !== "succeeded") {
    const got =
      doc.outcome === undefined || doc.outcome === null
        ? "<missing>"
        : String(doc.outcome);
    throw new Error(`pipeline outcome is not succeeded (got: ${got})`);
  }
  if (doc.ok !== true) {
    const got =
      doc.ok === undefined || doc.ok === null ? "<missing>" : String(doc.ok);
    throw new Error(`pipeline ok is not true (got: ${got})`);
  }
}

function resolveRunContext(
  parsed: ParsedEnvelopeArgs,
  cwd: string,
  store: RunStore,
): RunContext {
  if (parsed.fromPath !== undefined) {
    const resolved = path.resolve(cwd, parsed.fromPath);
    let raw: string;
    try {
      raw = readFileSync(resolved, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read --from file: ${message}`);
    }
    const fromDoc = parseSfRunDocument(raw);
    if (parsed.format === "handoff") {
      assertSfRunSucceededForHandoff(fromDoc);
    }
    const runId = fromDoc.runId ?? parsed.runId;
    if (!runId) {
      throw new Error("--from file must contain a JSON object with runId");
    }
    return {
      runId,
      runDir: fromDoc.runDir ?? store.getWorkspaceDir(runId),
    };
  }

  if (!parsed.runId) {
    throw new Error("Missing --run (or --from <sf-run.json>)");
  }

  return {
    runId: parsed.runId,
    runDir: store.getWorkspaceDir(parsed.runId),
  };
}

function isEnvelopeNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith("Envelope not found:")
  );
}

export const SYNTHETIC_SKIPPED_ENVELOPE: SyntheticSkippedEnvelope = {
  status: "skipped",
  summary: "stage was fork-skipped",
  artifacts: [],
  fork_choice: null,
};

async function readStageEnvelopeOrSynthetic(
  store: RunStore,
  runId: string,
  stageId: string,
): Promise<EnvelopeOutput> {
  try {
    return await store.readEnvelope(runId, stageId);
  } catch (err) {
    if (!isEnvelopeNotFoundError(err)) {
      throw err;
    }
    const detail = await store.readRun(runId);
    const stage = detail.stages.find((s) => s.stage_id === stageId);
    if (!stage) {
      throw new Error(`Stage not found: ${stageId} in run ${runId}`);
    }
    if (stage.status === "skipped") {
      return SYNTHETIC_SKIPPED_ENVELOPE;
    }
    throw new Error(`No envelope found for stage '${stageId}' in run '${runId}'`);
  }
}

function formatEnvelopeHuman(stageId: string, envelope: EnvelopeOutput): string {
  return `[${stageId}] status=${envelope.status}  summary: ${envelope.summary}  artifacts: ${envelope.artifacts.length}`;
}

function formatHandoffHuman(result: HandoffResult): string {
  if (result.skipped) {
    return "handoff: skipped";
  }
  return `handoff: ${result.diagrams.length} diagram(s)`;
}

export async function runEnvelopeCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<EnvelopeCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: EnvelopeCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedEnvelopeArgs;
  try {
    parsed = parseEnvelopeArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(ENVELOPE_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(ENVELOPE_USAGE);
    return 0;
  }

  if (parsed.subcommand !== "get") {
    out.error("Missing envelope subcommand");
    out.error(ENVELOPE_USAGE);
    return 1;
  }

  if (!parsed.stageId) {
    out.error("Missing --stage");
    out.error(ENVELOPE_USAGE);
    return 1;
  }

  const store = createRunStore({ rootDir: projectRoot });

  let runContext: RunContext;
  try {
    runContext = resolveRunContext(parsed, cwd, store);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(ENVELOPE_USAGE);
    return 1;
  }

  try {
    if (parsed.format === "handoff") {
      if (parsed.detectStageId !== undefined) {
        const detectEnvelope = await store.readEnvelope(
          runContext.runId,
          parsed.detectStageId,
        );
        if (isHandoffSkipped(detectEnvelope)) {
          const skipped: HandoffResult = { skipped: true };
          if (parsed.json) {
            out.log(JSON.stringify(skipped));
          } else {
            out.log(formatHandoffHuman(skipped));
          }
          return 0;
        }
      }

      const authorEnvelope = await readStageEnvelopeOrSynthetic(
        store,
        runContext.runId,
        parsed.stageId,
      );
      if (authorEnvelope.status === "skipped") {
        throw new Error(
          `No envelope found for stage '${parsed.stageId}' in run '${runContext.runId}'`,
        );
      }

      const handoff = buildHandoffDeliverable({
        runId: runContext.runId,
        runDir: runContext.runDir,
        stageId: parsed.stageId,
        envelope: authorEnvelope,
      });

      if (parsed.json) {
        out.log(JSON.stringify(handoff));
      } else {
        out.log(formatHandoffHuman(handoff));
      }
      return 0;
    }

    const envelope = await readStageEnvelopeOrSynthetic(
      store,
      runContext.runId,
      parsed.stageId,
    );

    if (parsed.json) {
      out.log(JSON.stringify(envelope));
    } else {
      out.log(formatEnvelopeHuman(parsed.stageId, envelope));
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    return 1;
  }
}
