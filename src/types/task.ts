export type TaskFile = {
  id: string;
  goal: string;
  context?: string;
  constraints?: string;
  checkout?: string;
  input?: Record<string, unknown>;
};
