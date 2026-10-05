export type LiveViewSourceRequest = {
  runId: string;
  stageId: string;
  /** Opaque sandbox reference of the stage's browser. */
  sandboxId: string;
};

export type LiveViewAddress = {
  /** Short-lived and per-session. Never store it in a gate, run file, log or audit record. */
  url: string;
  /** Origin the console must allow to embed the viewer. */
  embedOrigin: string;
  expiresAt: number;
};

export interface LiveViewSource {
  viewerAddress(request: LiveViewSourceRequest): Promise<LiveViewAddress>;
}
