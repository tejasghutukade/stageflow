import type { ChannelErrorCode } from "./errors.js";

export type ChannelOperation = "send";

export type SecretRef = `env:${string}`;

export type ConnectionEntry = {
  id: string;
  provider: string;
  displayName?: string;
  enabled: boolean;
  credential?: string;
  config: Record<string, unknown>;
  secrets: Record<string, SecretRef>;
};

export type CredentialEntry = {
  id: string;
  provider: string;
  secrets: Record<string, SecretRef>;
};

export type ConnectionHealth = {
  state: "ok" | "failed";
  checkedAt: string;
  error?: { code: ChannelErrorCode; retryable: boolean };
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export type ResolvedCredential = { id: string; provider: string; secrets: Record<string, string> };

/**
 * Secret values are readable by providers but not enumerable, so JSON, logging and
 * `util.inspect` of a resolved connection never include them.
 */
export type ResolvedConnection<C = unknown> = {
  readonly id: string;
  readonly scope: string;
  readonly provider: string;
  readonly displayName: string;
  readonly config: C;
  readonly secrets: Readonly<Record<string, string>>;
  readonly credential?: ResolvedCredential;
};

export type OutboundMessage = { text: string; subject?: string };
export type SendContext = { operationKey: string; runId?: string; stageId?: string };
export type SendReceipt = {
  providerMessageId?: string;
  submittedAt: string;
  warnings?: string[];
};

export type ProviderSecretSpec = { required: readonly string[]; optional?: readonly string[] };

export interface ChannelProvider<C = unknown, T = unknown> {
  readonly id: string;
  readonly operations: readonly ChannelOperation[];
  readonly secrets: ProviderSecretSpec;
  /** When set, a connection must reference a credential of this provider kind. */
  readonly credentialProvider?: string;
  validateConfig(config: unknown): ValidationResult<C>;
  validateTarget(target: unknown): ValidationResult<T>;
  /** Masked, non-secret identity for listings, such as an address or workspace. */
  describe?(config: C): { identity?: string };
  check(connection: ResolvedConnection<C>, signal?: AbortSignal): Promise<ConnectionHealth>;
  /**
   * Optional live check of the targets stages pin on this connection, such as whether a
   * recipient is registered. Runs only after `check` succeeds. Targets are already validated.
   */
  checkTargets?(connection: ResolvedConnection<C>, targets: T[], signal?: AbortSignal): Promise<ConnectionHealth>;
  send(connection: ResolvedConnection<C>, target: T, message: OutboundMessage, context: SendContext): Promise<SendReceipt>;
}

export type AnyChannelProvider = ChannelProvider<any, any>;

export type ConnectionSummary = {
  id: string;
  scope: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  identity?: string;
  credential?: string;
};
