/** Stable network-facing error codes (snake_case). Keep strings unchanged once shipped. */

export const BUSY_CAPACITY = "busy_capacity" as const;
export const BUSY_CHECKOUT = "busy_checkout" as const;
/** Per-caller concurrency quota: queued when under global capacity; reject when queue full. */
export const BUSY_CALLER_QUOTA = "busy_caller_quota" as const;
export const ABORTED = "aborted" as const;

export const NETWORK_ERROR_CODES = [
  BUSY_CAPACITY,
  BUSY_CHECKOUT,
  BUSY_CALLER_QUOTA,
  ABORTED,
  "unknown_project_root",
  "absolute_path_not_allowed",
  "path_outside_project_root",
  "catalog_root_unreadable",
  "config_invalid",
  "config_unknown_key",
  "provider_not_configured",
  "a2a_configuration_error",
  "untrusted_config_origin",
  "command_not_on_path",
  "missing_tool",
  "tool_version_mismatch",
  "unknown_version",
  "secret_unavailable",
  "not_ready",
  "internal_error",
  "retry_in_progress",
  "hitl_not_retriable",
  "run_not_retryable",
  "stage_not_failed",
  "manual_recovery_required",
  "run_not_found",
  "stage_not_found",
  "artifact_not_found",
  "artifact_path_denied",
  "envelope_not_found",
  "insufficient_disk",
  "disk_check_failed",
  "shutting_down",
  "start.token_rejected",
  "inline_pipeline_too_large",
  "pinned_sha_unavailable",
  "store_integrity_failed",
  "store_unsupported_filesystem",
  "tmpdir_unusable",
  "backup_insufficient_disk",
] as const;

export type NetworkErrorCode = (typeof NETWORK_ERROR_CODES)[number] | string;

export type NetworkErrorBody = {
  code: NetworkErrorCode;
  error: string;
} & Record<string, unknown>;

export function networkError(
  code: NetworkErrorCode,
  error: string,
  detail?: Record<string, unknown>,
): NetworkErrorBody {
  return { code, error, ...detail };
}

export function codeOrInternal(
  code: string | undefined,
): NetworkErrorCode {
  return code && code.length > 0 ? code : "internal_error";
}
