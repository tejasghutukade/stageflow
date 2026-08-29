import type { StageEnvelope } from "./envelope.js";

export type ForkChoiceShape = {
  cardinality: "one" | "subset";
  allowNone: boolean;
};

export type ForkEmitContext = {
  immediateSuccessorIds: string[];
  forkShape: ForkChoiceShape | null;
};

export type CloneForkItem =
  | { successor_id: string; action: "skip" }
  | { successor_id: string; action: "once"; envelope: StageEnvelope }
  | {
      successor_id: string;
      action: "fanout";
      mode: "parallel" | "sequential";
      clones: Array<{ envelope: StageEnvelope }>;
    };

export type CloneEmitContext = {
  clonableSuccessors: Array<{ successorId: string; cloneCap: number }>;
};
