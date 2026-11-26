import type { ArtifactBindingQueryResponse } from "../../../api/artifacts";

export type LiveQuery = (input: {
  bindingId: string;
  args: Record<string, unknown>;
}) => Promise<{ status: number; body: ArtifactBindingQueryResponse | { error?: string; code?: string; retry_after_seconds?: number } | null; networkError?: string }>;
