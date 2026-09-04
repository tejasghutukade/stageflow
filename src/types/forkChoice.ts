import type { StageEnvelope } from "./envelope.js";

export type ForkChoiceShape = {
  cardinality: "one" | "subset";
  allowNone: boolean;
};

export type ForkEmitContext = {
  immediateSuccessorIds: string[];
  forkShape: ForkChoiceShape | null;
};

export const CLONE_ACTIONS = ["skip", "once", "fanout"] as const;

export type CloneAction = (typeof CLONE_ACTIONS)[number];

export type CloneForkItem =
  | { successor_id: string; action: "skip" }
  | { successor_id: string; action: "once"; envelope: StageEnvelope }
  | {
      successor_id: string;
      action: "fanout";
      mode: "parallel" | "sequential";
      clones: Array<{ envelope: StageEnvelope }>;
    };

export type CloneSuccessorEmit = {
  successorId: string;
  cloneCap: number;
  cloneInputSchema?: unknown;
};

export type CloneEmitContext = {
  clonableSuccessors: CloneSuccessorEmit[];
  allowedActions?: CloneAction[];
};
