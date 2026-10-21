export type EngineErrorCode =
  | "EVAL_NODE_TOO_OLD"
  | "EVAL_ENGINE_UNAVAILABLE"
  | "EVAL_ENGINE_ERROR"
  | "EVAL_INVALID";

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
