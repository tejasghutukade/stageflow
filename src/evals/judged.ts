import type { ResolvedGrader } from "./types.js";

export type JudgedGrader = Extract<ResolvedGrader, { type: "rubric" | "goal_reached" }>;

/** Grader types a model judges. The only place that lists them. */
export function isJudgedType(type: string): boolean {
  return type === "rubric" || type === "goal_reached";
}

export function isJudged(grader: ResolvedGrader): grader is JudgedGrader {
  return isJudgedType(grader.type);
}
