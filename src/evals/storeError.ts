import type { EvalErrorCode } from "./constants.js";

export class EvalStoreError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvalStoreError";
  }
}
