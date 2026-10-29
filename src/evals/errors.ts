import type { ValidationFinding } from "../config/validateCatalog.js";
import type { EvalErrorCode } from "./constants.js";

export class EvalRunError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    message: string,
    readonly findings?: ValidationFinding[],
  ) {
    super(message);
    this.name = "EvalRunError";
  }
}
