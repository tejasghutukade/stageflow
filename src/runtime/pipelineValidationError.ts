import type { ValidationResult } from "../config/validateCatalog.js";

export class PipelineValidationError extends Error {
  readonly result: ValidationResult;
  override readonly name = "PipelineValidationError";

  constructor(result: ValidationResult) {
    super("Pipeline validation failed");
    this.result = result;
  }
}
