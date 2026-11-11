import { describe, expect, it } from "vitest";
import {
  cliProgressColor,
  createRunProgressWriter,
  progressLines,
} from "../src/cli/runProgress.js";
import type { StageLogEvent, StageSnapshot } from "../src/runstore/port.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import type { StageEnvelope } from "../src/types/envelope.js";

function stage(
  stage_id: string,
  status: StageSnapshot["status"],
  events: StageLogEvent[] = [],
  extra: {
    envelope?: StageEnvelope | null;
    artifacts?: string[];
    pending_prompt?: AskOperatorPrompt;
  } = {},
): StageSnapshot {
  return {
    stage_id,
    status,
    events,
    envelope: extra.envelope ?? null,
    artifacts: extra.artifacts ?? [],
    attempt_count: 1,
    ...(extra.pending_prompt ? { pending_prompt: extra.pending_prompt } : {}),
  };
}

const t0 = Date.parse("2026-11-11T00:00:00.000Z");

describe("progressLines", () => {
  it("draws a timeline with the live stage open and later stages waiting", () => {
    const lines = progressLines(
      {
        stages: [
          stage(
            "outline",
            "succeeded",
            [
              { event: "started", at: new Date(t0).toISOString() },
              { event: "succeeded", at: new Date(t0 + 8200).toISOString() },
            ],
            { artifacts: ["stages/outline/attempts/1/artifacts/outline.txt"] },
          ),
          stage("draft", "running", [
            { event: "started", at: new Date(t0).toISOString() },
            {
              event: "tool_start",
              toolName: "bash",
              argsPreview: JSON.stringify({ command: "printf hello" }),
            },
          ]),
          stage("polish", "pending"),
        ],
      },
      t0 + 12_000,
    );
    expect(lines.map((line) => line.text)).toEqual([
      "● outline                                           8.2s",
      "│  wrote outline.txt",
      "● draft                                              12s",
      "│  calling bash: printf hello",
      "○ polish                                         waiting",
    ]);
    expect(lines.map((line) => line.tone)).toEqual([
      "succeeded",
      "succeeded",
      "running",
      "running",
      "waiting",
    ]);
  });

  it("keeps a failure reason on the rail under the stage", () => {
    const lines = progressLines({
      stages: [
        stage("outline", "failed", [
          { event: "failed", reason: "model rejected the envelope" },
        ]),
        stage("polish", "skipped"),
      ],
    });
    expect(lines.map((line) => line.text)).toEqual([
      "✖ outline",
      "│  model rejected the envelope",
      "○ polish                                         skipped",
    ]);
  });

  it("shows the question and freezes the clock once a stage is parked", () => {
    const lines = progressLines(
      {
        stages: [
          stage("review", "waiting_for_input", [
            { event: "started", at: new Date(t0).toISOString() },
            { event: "waiting_for_input", at: new Date(t0 + 3200).toISOString() },
          ], {
            pending_prompt: {
              kind: "confirm",
              id: "q1",
              message: "Publish this one-line brief?",
            },
          }),
        ],
      },
      t0 + 60_000,
      { questions: true },
    );
    expect(lines.map((line) => line.text)).toEqual([
      "● review                                            3.2s",
      "│  Publish this one-line brief?",
    ]);
  });

  it("skips the stage kickoff and keeps the later action", () => {
    const lines = progressLines({
      stages: [
        stage("draft", "running", [
          {
            event: "message",
            role: "user",
            text: "Begin this stage. Your task, inputs, constraints and the required final action are in your system prompt.",
          },
          { event: "tool_start", toolName: "ask_operator" },
        ]),
      ],
    });
    expect(lines.map((line) => line.text)).toEqual([
      "● draft",
      "│  calling ask_operator",
    ]);
  });

  it("keeps the tool call when a later turn starts", () => {
    const lines = progressLines({
      stages: [
        stage("draft", "running", [
          { event: "tool_start", toolName: "ls" },
          { event: "turn_start" },
        ]),
      ],
    });
    expect(lines.map((line) => line.text)).toEqual(["● draft", "│  calling ls"]);
  });

  it("redacts a secret in the activity line", () => {
    const lines = progressLines({
      stages: [
        stage("outline", "running", [
          {
            event: "tool_start",
            toolName: "bash",
            argsPreview: JSON.stringify({
              command: "echo sk-abcdefghijklmnopqrstuvwxyz",
            }),
          },
        ]),
      ],
    });
    const detail = lines.find((line) => line.role === "detail");
    expect(detail?.text).toContain("[redacted]");
    expect(detail?.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});

function visualLines(chunk: string): string[] {
  const lines: string[] = [];
  for (const raw of chunk.replace(/^\x1b\[\d+A/, "").split("\n")) {
    if (!raw.startsWith("\x1b[2K")) continue;
    lines.push(raw.replace(/^\x1b\[2K/, "").replace(/\x1b\[[0-9;]*m/g, ""));
  }
  return lines;
}

const longRunning = {
  stages: [
    stage("draft", "running", [
      { event: "started", at: new Date(t0).toISOString() },
      {
        event: "tool_start",
        toolName: "bash",
        argsPreview: JSON.stringify({
          command: "printf hello from a very long command",
        }),
      },
    ]),
  ],
};

describe("createRunProgressWriter", () => {
  it("rewrites the block on a tty and colors the finished stage", () => {
    const chunks: string[] = [];
    const writer = createRunProgressWriter({
      write: (chunk) => chunks.push(chunk),
      tty: true,
      color: true,
    });
    writer.update({
      stages: [stage("outline", "running", [{ event: "started" }])],
    });
    writer.update({
      stages: [stage("outline", "succeeded")],
    });
    expect(chunks[0]).toBe(
      "\x1b[2K\x1b[36m● outline\x1b[0m\n\x1b[2K\x1b[2m│  \x1b[0mstarting\n",
    );
    expect(chunks[1]?.startsWith("\x1b[2A")).toBe(true);
    expect(chunks[1]).toContain("\x1b[32m● outline\x1b[0m");
  });

  it("appends only changed lines when stdout is not a tty", () => {
    const chunks: string[] = [];
    const writer = createRunProgressWriter({
      write: (chunk) => chunks.push(chunk),
      tty: false,
      color: false,
    });
    writer.update({
      stages: [stage("outline", "running", [{ event: "tool_start", toolName: "read" }])],
    });
    writer.update({
      stages: [stage("outline", "running", [{ event: "tool_start", toolName: "read" }])],
    });
    writer.update({
      stages: [
        stage("outline", "succeeded", [], {
          artifacts: ["outline.txt"],
        }),
        stage("draft", "running", [{ event: "started" }]),
      ],
    });
    expect(chunks).toEqual([
      "● outline\n│  calling read\n",
      "│  wrote outline.txt\n● draft\n│  starting\n",
    ]);
  });

  it("truncates tty lines to the given width and cursor-ups one row per line", () => {
    const chunks: string[] = [];
    const now = t0 + 12_000;
    const writer = createRunProgressWriter({
      write: (chunk) => chunks.push(chunk),
      tty: true,
      color: true,
      columns: 20,
      now: () => now,
    });
    writer.update(longRunning);
    writer.update({
      stages: [stage("draft", "succeeded", [], { artifacts: ["draft.txt"] })],
    });
    const source = progressLines(longRunning, now, { questions: true }).map((line) => line.text);
    const shown = visualLines(chunks[0] ?? "");
    const wrapped = source.reduce(
      (rows, line) => rows + Math.max(1, Math.ceil(line.length / 20)),
      0,
    );
    expect(source.some((line) => line.length > 20)).toBe(true);
    expect(shown).toEqual(source.map((line) => line.slice(0, 20)));
    expect(wrapped).toBeGreaterThan(shown.length);
    expect(chunks[1]?.startsWith(`\x1b[${shown.length}A`)).toBe(true);
    expect(chunks[1]?.startsWith(`\x1b[${wrapped}A`)).toBe(false);
  });

  it("cursor-ups on a tty when no column width is given", () => {
    const chunks: string[] = [];
    const writer = createRunProgressWriter({
      write: (chunk) => chunks.push(chunk),
      tty: true,
      color: false,
    });
    writer.update(longRunning);
    writer.update({ stages: [stage("draft", "succeeded")] });
    const shown = visualLines(chunks[0] ?? "");
    expect(shown.some((line) => line.length > 20)).toBe(true);
    expect(chunks[0]).toContain("printf hello from a very long command");
    expect(chunks[1]?.startsWith(`\x1b[${shown.length}A`)).toBe(true);
  });

  it("keeps appending full lines when stdout is not a tty", () => {
    const chunks: string[] = [];
    const now = t0 + 12_000;
    const writer = createRunProgressWriter({
      write: (chunk) => chunks.push(chunk),
      tty: false,
      color: false,
      columns: 20,
      now: () => now,
    });
    writer.update(longRunning);
    writer.update(longRunning);
    const text = progressLines(longRunning, now, { questions: true })
      .map((line) => line.text)
      .join("\n");
    expect(text).toContain("printf hello from a very long command");
    expect(chunks).toEqual([`${text}\n`]);
  });

  it("prints a fresh block after reset so a prompt stays above the timeline", () => {
    const chunks: string[] = [];
    const writer = createRunProgressWriter({
      write: (chunk) => chunks.push(chunk),
      tty: true,
      color: false,
    });
    writer.update({ stages: [stage("outline", "running", [{ event: "started" }])] });
    writer.reset();
    writer.update({ stages: [stage("outline", "succeeded")] });
    expect(chunks[1]).not.toContain("\x1b[1A");
    expect(chunks[1]?.startsWith("\x1b[2K")).toBe(true);
    expect(chunks[1]).toContain("● outline");
  });
});

describe("cliProgressColor", () => {
  it("follows the tty unless NO_COLOR or FORCE_COLOR says otherwise", () => {
    expect(cliProgressColor(true, {})).toBe(true);
    expect(cliProgressColor(false, {})).toBe(false);
    expect(cliProgressColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(cliProgressColor(false, { FORCE_COLOR: "1" })).toBe(true);
    expect(cliProgressColor(true, { FORCE_COLOR: "0" })).toBe(false);
  });
});
