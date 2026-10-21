export type StoreOpenErrorCode =
  | "store_integrity_failed"
  | "store_unsupported_filesystem"
  | "tmpdir_unusable";

export class StoreOpenError extends Error {
  readonly code: StoreOpenErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    message: string,
    code: StoreOpenErrorCode,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StoreOpenError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
