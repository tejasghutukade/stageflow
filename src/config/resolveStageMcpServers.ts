export type StageMcpErrorCode =
  | "missing_catalog"
  | "unknown_server"
  | "reserved_name"
  | "unresolved_var"
  | "invalid_config"
  | "connect_failed";

export class StageMcpError extends Error {
  readonly code: StageMcpErrorCode;

  constructor(message: string, code: StageMcpErrorCode) {
    super(message);
    this.name = "StageMcpError";
    this.code = code;
  }
}

export type ResolvedMcpServerConfig = Record<string, unknown>;

export type ResolvedMcpServers = Record<string, ResolvedMcpServerConfig>;
