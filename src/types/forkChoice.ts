export type ForkChoiceShape = {
  cardinality: "one" | "subset";
  allowNone: boolean;
};

export type ForkEmitContext = {
  immediateSuccessorIds: string[];
  forkShape: ForkChoiceShape | null;
};
