import { diffLines, splitLines } from "./lineDiff";

export type WorkshopTip = { title: string; body: string };

export type WorkshopTipTopic =
  | "on_verify_fail"
  | "verify"
  | "ask_operator"
  | "io"
  | "route"
  | "model";

type TipArtifact = { before?: string; after?: string };

export const WORKSHOP_TIPS: Record<WorkshopTipTopic, WorkshopTip> = {
  on_verify_fail: {
    title: "on_verify_fail",
    body: "on_verify_fail only runs after an after-phase verify check fails. mode: repair starts fresh attempts up to max_attempts (include_failed_checks carries the failure evidence); use mode: manual for side-effecting work.",
  },
  verify: {
    title: "verify",
    body: "after-phase verify checks (the default for type: command) run once the stage emits its envelope. A failing check fails the attempt unless on_verify_fail recovers it.",
  },
  ask_operator: {
    title: "ask_operator",
    body: "ask_operator is only registered when the stage lists gate_kinds. Omit it or use [] to turn the HITL tool off; a type: gate check's kind must also appear in gate_kinds.",
  },
  io: {
    title: "io",
    body: "every stage needs io.input.schema and io.output.schema. The output schema is the producer contract: the success payload is validated against it when the stage emits.",
  },
  route: {
    title: "route",
    body: "wiring lives on the source stage as route: [{ to: next }], with at least one entry: true root. needs is rejected; an optional if on a route entry is checked against the source stage's output payload.",
  },
  model: {
    title: "model",
    body: "a stage without model inherits one at load: stage model, then the root pipeline model, then stageflow.yaml. Leave model off a stage to follow the pipeline default.",
  },
};

const TOPIC_ORDER: WorkshopTipTopic[] = [
  "on_verify_fail",
  "verify",
  "ask_operator",
  "io",
  "route",
  "model",
];

const KEY_TOPICS: Record<string, WorkshopTipTopic> = {
  on_verify_fail: "on_verify_fail",
  verify: "verify",
  gate_kinds: "ask_operator",
  ask_operator: "ask_operator",
  io: "io",
  route: "route",
  needs: "route",
  entry: "route",
  model: "model",
};

const KEY_PATTERN = /^(\s*)(?:-\s*)?"?([A-Za-z_][\w.-]*)"?\s*:/;

function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1]!.length : 0;
}

function keysWithAncestors(lines: readonly string[], index: number): string[] {
  const keys: string[] = [];
  const own = KEY_PATTERN.exec(lines[index]!);
  if (own) keys.push(own[2]!);
  let indent = indentOf(lines[index]!);
  for (let k = index - 1; k >= 0 && indent > 0; k -= 1) {
    const line = lines[k]!;
    if (!line.trim()) continue;
    const lineIndent = indentOf(line);
    if (lineIndent >= indent) continue;
    const match = KEY_PATTERN.exec(line);
    if (match) keys.push(match[2]!);
    indent = lineIndent;
  }
  return keys;
}

export function touchedTopics(artifact: TipArtifact): Set<WorkshopTipTopic> {
  const topics = new Set<WorkshopTipTopic>();
  const beforeLines = splitLines(artifact.before);
  const afterLines = splitLines(artifact.after);
  for (const line of diffLines(artifact.before, artifact.after)) {
    if (line.kind === "context") continue;
    const source = line.kind === "added" ? afterLines : beforeLines;
    const index = (line.kind === "added" ? line.newLine : line.oldLine)! - 1;
    for (const key of keysWithAncestors(source, index)) {
      const topic = KEY_TOPICS[key];
      if (topic) topics.add(topic);
    }
    if (/ask_operator/.test(line.text) || /"?type"?\s*:\s*"?gate\b/.test(line.text)) {
      topics.add("ask_operator");
    }
  }
  return topics;
}

export function tipTopicForProposal(
  proposal: { artifacts?: readonly TipArtifact[] } | null | undefined,
): WorkshopTipTopic | null {
  const artifacts = proposal?.artifacts ?? [];
  const topics = new Set<WorkshopTipTopic>();
  for (const artifact of artifacts) {
    for (const topic of touchedTopics(artifact)) topics.add(topic);
  }
  return TOPIC_ORDER.find((topic) => topics.has(topic)) ?? null;
}

export function tipForProposal(
  proposal: { artifacts?: readonly TipArtifact[] } | null | undefined,
): WorkshopTip | null {
  const topic = tipTopicForProposal(proposal);
  return topic ? WORKSHOP_TIPS[topic] : null;
}
