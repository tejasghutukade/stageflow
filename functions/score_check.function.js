---
id: score_check
name: Score check
description: Accepts a report when its score meets the bound threshold.
kind: verification
timeout_ms: 5000
---
export const access = {
  artifacts: "read",
  env: ["MIN_SCORE"],
  network: [],
};

export default async function execute(context) {
  const report = await context.artifacts.readJson("report.json");
  const threshold = Number(context.env.MIN_SCORE);
  if (!Number.isFinite(threshold) || typeof report.score !== "number") {
    throw new Error("Expected a numeric report score and configured threshold");
  }
  const passed = report.score >= threshold;
  return {
    passed,
    message: passed ? "Score accepted" : "Score below threshold",
  };
}
