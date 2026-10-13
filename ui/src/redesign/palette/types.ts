export type PaletteGroup = "actions" | "runs" | "pipelines" | "navigation";

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  context?: string;
  keywords?: string;
  score: number;
  run: () => void;
};

export type PaletteNavDef = {
  id: string;
  label: string;
  path: string;
};

export type PaletteActionContext = {
  firstWaitingRunId?: string;
  firstBrokenRunId?: string;
  onStartRun: () => void;
  onNavigate: (path: string) => void;
  onRetryBroken?: (runId: string) => void;
};
