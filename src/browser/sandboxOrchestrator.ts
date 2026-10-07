export type SandboxLabels = {
  scope: string;
  runId: string;
  stageId?: string;
  profile?: string;
};

export type SandboxRef = {
  /** Stable reference chosen by the adapter; opaque to the core. */
  id: string;
  /** The one place adapter data lives; only the issuing adapter reads it. */
  adapter: { id: string; version: number; data?: unknown };
};

/**
 * Reserved seam for restricting what a sandbox may reach. No implementation
 * enforces it yet; adapters that cannot enforce a policy must reject it with
 * `not_supported` rather than ignore it. A hard `allow_domains` guarantee
 * (private network plus filtering proxy) lands here later.
 */
export type SandboxEgressPolicy = {
  allowDomains?: string[];
  adapter?: { id: string; version: number; data?: unknown };
};

export type SandboxStartRequest = {
  labels: SandboxLabels;
  profile?: { scope: string; name: string };
  egress?: SandboxEgressPolicy;
};

export type SandboxStatus = "running" | "stopped" | "dead";

export type SandboxInfo = {
  ref: SandboxRef;
  labels: SandboxLabels;
  status: SandboxStatus;
  /** Present while the sandbox is running. */
  attachAddress?: string;
};

export type SandboxErrorClass =
  | "unavailable"
  | "out_of_capacity"
  | "not_authorized"
  | "not_supported"
  | "failed";

export class SandboxError extends Error {
  constructor(
    readonly errorClass: SandboxErrorClass,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface BrowserSandboxOrchestrator {
  start(request: SandboxStartRequest): Promise<SandboxInfo>;
  /** Closes the browser cleanly (flushing profile state) without releasing the sandbox. */
  stopGracefully(ref: SandboxRef): Promise<void>;
  listByLabel(labels: Partial<SandboxLabels>): Promise<SandboxInfo[]>;
  inspect(ref: SandboxRef): Promise<SandboxInfo | undefined>;
  /** Idempotent: releasing an unknown or already released sandbox succeeds. */
  release(ref: SandboxRef): Promise<void>;
}
