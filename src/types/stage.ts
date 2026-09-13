import type { PreEmitCheck } from "./preEmitCheck.js";

/** Typed emit/schema fields from `compileTargetContract`. Not catalog YAML keys. */
export type CompiledStageEmitBody = {
  payload_schema?: unknown;
  clone_input_schema?: unknown;
  pre_emit_checks?: PreEmitCheck[];
};

export const STAGE_GATE_KINDS = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
] as const;

export type StageGateKind = (typeof STAGE_GATE_KINDS)[number];

/** Target YAML `io:` block. Compiles onto StageConfig.payload_schema / clone_input_schema. */
export type StageIoYaml = {
  input: { schema: unknown };
  output: { schema: unknown };
};

/**
 * Loaded stage IR. Field names are the runtime contract (emit, VSE, snapshots),
 * not the catalog YAML spelling. Target YAML `io` / `verify` compile onto these
 * in `src/config/yamlDialect.ts`. Do not add new catalog keys here — add them on
 * the YAML dialect and map them in compileTargetContract.
 */
export type StageConfig = {
  id: string;
  system_prompt: string;
  model?: string;
  /** IR: success envelope.payload schema. YAML: `io.output.schema`. */
  payload_schema?: unknown;
  /** Declared ask_operator kinds this stage is expected to stop on. */
  gate_kinds?: StageGateKind[];
  /** IR: emit-phase checks. YAML: `verify` items whose `when` includes `emit`. */
  pre_emit_checks?: PreEmitCheck[];
  /** IR: inbound assignment schema. YAML: `io.input.schema`. */
  clone_input_schema?: unknown;
  /** Optional stage wall-clock timeout in milliseconds (default 60 minutes). */
  timeout_ms?: number;
  skill?: string;
  mcp?: string[];
  /**
   * Selects the AgentPort backend for this stage, overriding pipeline/global.
   * Parsed but not yet consulted — see STAGE_LEVEL_AGENT_OVERRIDE_ENABLED.
   */
  agent?: string;
};

export type LoadedStageConfig = StageConfig & { model: string };
