import type { ResolvedGrader } from "../../types.js";
import { mapJudge, unsupportedJudgeMessage } from "../../judgeProviders.js";
import { EngineError } from "./errors.js";
import { isJudged } from "../../judged.js";

export function assertJudgesSupported(graders: readonly ResolvedGrader[]): void {
  for (const grader of graders) {
    if (isJudged(grader) && mapJudge(grader.judge) === null) {
      throw new EngineError("EVAL_INVALID", unsupportedJudgeMessage(grader.judge));
    }
  }
}
