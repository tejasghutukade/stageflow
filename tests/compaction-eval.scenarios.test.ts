import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesText, transcriptText } from "../scripts/compaction-eval/scenarios/builder.js";
import { loadExistingSession, SCENARIOS } from "../scripts/compaction-eval/scenarios/index.js";

describe("compaction-eval scenarios", () => {
  it("covers the seven families", () => {
    expect(new Set(SCENARIOS.map((s) => s.family)).size).toBe(7);
  });

  for (const entry of SCENARIOS) {
    describe(entry.id, () => {
      const scenario = entry.build();

      it("is deterministic for a seed and differs across seeds", () => {
        expect(JSON.stringify(entry.build().messages)).toBe(JSON.stringify(scenario.messages));
        expect(JSON.stringify(entry.build(99).messages)).not.toBe(JSON.stringify(scenario.messages));
      });

      it("has at least 150k characters and a quiet tail", () => {
        expect(transcriptText(scenario.messages).length).toBeGreaterThanOrEqual(150_000);
        expect(scenario.keepTail).toBeGreaterThan(0);
      });

      it("plants every fact before the kept tail, spread over positions", () => {
        const region = transcriptText(scenario.messages.slice(0, scenario.messages.length - scenario.keepTail));
        for (const fact of scenario.facts) expect(matchesText(fact.mustContain, region), fact.id).toBe(true);
        expect(new Set(scenario.facts.map((f) => f.where)).size).toBe(3);
        expect(scenario.facts.some((f) => f.critical)).toBe(true);
        expect(scenario.probes.length).toBeGreaterThan(0);
      });

      it("keeps secrets in the transcript", () => {
        const text = transcriptText(scenario.messages);
        for (const secret of scenario.secrets) expect(text).toContain(secret);
      });
    });
  }

  it("the browser scenario declares secrets", () => {
    expect(SCENARIOS.find((s) => s.family === "browser")!.build().secrets.length).toBeGreaterThan(0);
  });

  it("loads a real session JSONL without planted facts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ceval-"));
    const file = path.join(dir, "tiny.jsonl");
    const lines = [
      { type: "session", id: "s" },
      { type: "message", message: { role: "system", content: "x" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    const scenario = loadExistingSession(file, { keepTail: 2 });
    expect(scenario.family).toBe("existing-session");
    expect(scenario.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(scenario.facts).toEqual([]);
    expect(scenario.keepTail).toBe(2);
  });
});
