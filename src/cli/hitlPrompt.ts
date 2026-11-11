import path from "node:path";
import readline from "node:readline";
import { redactString } from "../logging/redact.js";
import type {
  AskOperatorAnswer,
  AskOperatorPrompt,
  Decision,
  FreeTextOrConfirmPayload,
} from "../tools/askOperator.js";

export type HitlPromptIo = {
  log: (line: string) => void;
  /** One line, without the trailing newline. Null means the operator cancelled. */
  readLine: () => Promise<string | null>;
};

export function hitlArtifactPaths(
  artifacts: readonly string[],
  runDir: string | undefined,
  stageArtifacts: readonly string[] = [],
): string[] {
  return artifacts.map((artifact) => {
    const stored = matchStoredArtifact(artifact, stageArtifacts);
    const chosen = stored ?? artifact;
    if (path.isAbsolute(chosen) || runDir === undefined || runDir.length === 0) {
      return chosen;
    }
    return path.join(runDir, chosen);
  });
}

export async function collectHitlAnswer(
  prompt: AskOperatorPrompt,
  io: HitlPromptIo,
  options: { runDir?: string; stageArtifacts?: readonly string[] } = {},
): Promise<AskOperatorAnswer | null> {
  if (prompt.kind === "free_text") {
    const text = await askText(io, prompt.message);
    if (text === null) return null;
    return { promptId: prompt.id, kind: "free_text", text };
  }
  if (prompt.kind === "confirm") {
    const decision = await askDecision(io, [prompt.message]);
    if (decision === null) return null;
    return { promptId: prompt.id, kind: "confirm", decision };
  }
  if (prompt.kind === "artifact_backed") {
    const paths = hitlArtifactPaths(
      prompt.artifacts,
      options.runDir,
      options.stageArtifacts,
    );
    const decision = await askDecision(io, [prompt.message, "", ...paths]);
    if (decision === null) return null;
    return { promptId: prompt.id, kind: "artifact_backed", decision };
  }
  const answers: Record<string, FreeTextOrConfirmPayload> = {};
  const total = prompt.questions.length;
  for (let index = 0; index < prompt.questions.length; index++) {
    const question = prompt.questions[index];
    if (!question) continue;
    const heading = `${index + 1} of ${total}`;
    if (question.kind === "free_text") {
      const text = await askText(io, `${heading}\n${question.message}`);
      if (text === null) return null;
      answers[question.id] = { kind: "free_text", text };
    } else {
      const decision = await askDecision(io, [`${heading}\n${question.message}`]);
      if (decision === null) return null;
      answers[question.id] = { kind: "confirm", decision };
    }
  }
  return { promptId: prompt.id, kind: "multi_question", answers };
}

export function ackHitlAnswer(answer: AskOperatorAnswer): string {
  if (answer.kind === "confirm" || answer.kind === "artifact_backed") {
    return answer.decision === "accept" ? "Accepted." : "Rejected.";
  }
  return "Answered.";
}

export function readTTYLine(): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once("SIGINT", () => finish(null));
    rl.once("close", () => finish(null));
    rl.question("> ", (answer) => finish(answer));
  });
}

function visible(text: string): string {
  return text
    .split("\n")
    .map((line) => redactString(line).replace(/[ \t]+/g, " ").trim())
    .join("\n");
}

function matchStoredArtifact(
  artifact: string,
  stageArtifacts: readonly string[],
): string | undefined {
  const exact = stageArtifacts.find((candidate) => candidate === artifact);
  if (exact) return exact;
  const suffix = stageArtifacts.find((candidate) => candidate.endsWith(`/${artifact}`));
  if (suffix) return suffix;
  const base = path.basename(artifact);
  const byBase = stageArtifacts.filter((candidate) => path.basename(candidate) === base);
  return byBase.length === 1 ? byBase[0] : undefined;
}

async function askText(io: HitlPromptIo, message: string): Promise<string | null> {
  io.log(visible(message));
  return io.readLine();
}

async function askDecision(
  io: HitlPromptIo,
  lines: string[],
): Promise<Decision | null> {
  const intro = lines
    .map((line) => (line.length === 0 ? "" : visible(line)))
    .join("\n");
  for (;;) {
    io.log(`${intro}\n\n  1  accept\n  2  reject`);
    const line = await io.readLine();
    if (line === null) return null;
    const decision = parseDecisionChoice(line);
    if (decision) return decision;
    io.log("Choose 1 or 2.");
  }
}

function parseDecisionChoice(line: string): Decision | undefined {
  const value = line.trim().toLowerCase();
  if (value === "1" || value === "accept" || value === "a") return "accept";
  if (value === "2" || value === "reject" || value === "r") return "reject";
  return undefined;
}
