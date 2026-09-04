import type { CloneForkItem } from "./forkChoice.js";

export type EnvelopeStatus = "success" | "failure";

export type StageEnvelope = {
  status: EnvelopeStatus;
  summary: string;
  artifacts: string[];
  payload?: Record<string, unknown>;
  fork_choice?: string[];
  clone_forks?: CloneForkItem[];
  /** Agent's explicit acknowledgement of pipeline-owned checklist items. */
  checklist_attestations?: Array<{ check_id: string; items: string[] }>;
  stage_id?: string;
  notes?: string;
};

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}
