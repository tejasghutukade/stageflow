export const STAGE_GATE_KINDS = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
] as const;

export type StageGateKind = (typeof STAGE_GATE_KINDS)[number];

export type StageConfig = {
  id: string;
  system_prompt: string;
  model: string;
  /** Optional JSON Schema (subset) for envelope.payload on success. */
  payload_schema?: unknown;
  /** Declared ask_operator kinds this stage is expected to stop on. */
  gate_kinds?: StageGateKind[];
  skill?: string;
};
