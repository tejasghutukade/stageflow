import { describe, expect, it } from "vitest";
import { extractDirectives, mergeDirectives, renderDirectives } from "../src/compaction/directives.js";
import { prepareSummaryInputs, renderSections } from "../src/compaction/summarize.js";

const text = (t: string) => [{ type: "text", text: t }];
const messages = [
  { role: "user", content: text("Migrate the tables. Ask the operator when unsure.") },
  { role: "user", content: text("Begin this stage. Your task is in the system prompt.") },
  { role: "toolResult", toolName: "ask_operator", content: text("Use the staging database stg-db-03. Never touch production prod-db-01.") },
  { role: "toolResult", toolName: "bash", content: text("rows rows rows") },
  { role: "toolResult", toolName: "emit_stage_envelope", isError: true, content: text("Rejected by operator: plan must name the backup table.") },
  { role: "toolResult", toolName: "emit_stage_envelope", isError: false, content: text("accepted") },
  { role: "user", content: text("Reminder 1 of 2: your turn ended without an accepted emit_stage_envelope call") },
  { role: "user", content: text("Also keep Authorization: Bearer abcdefghijklmnop out of the notes") },
];

describe("directives", () => {
  it("keeps operator answers, rejected emits and user messages; skips kickoff and reminder noise", () => {
    const out = extractDirectives(messages);
    expect(out.map((d) => d.source)).toEqual(["user", "operator", "rejection", "user"]);
    expect(out[1]!.text).toContain("Never touch production prod-db-01");
    expect(out[2]!.text).toContain("plan must name the backup table");
    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop");
    expect(out[0]!.text).toContain("Migrate the tables");
    expect(JSON.stringify(out)).not.toContain("Reminder 1 of 2");
    expect(JSON.stringify(out)).not.toContain("Begin this stage");
  });

  it("merges without duplicates, keeps the newest within the cap, and renders newest-first under a budget", () => {
    const a = { source: "operator" as const, text: "A" };
    const b = { source: "operator" as const, text: "B" };
    const c = { source: "user" as const, text: "C" };
    expect(mergeDirectives([a, b], [b, c], 2)).toEqual([b, c]);
    const long = Array.from({ length: 30 }, (_, i) => ({ source: "operator" as const, text: `decision number ${i} `.repeat(4) }));
    const rendered = renderDirectives(long, 600);
    expect(rendered.length).toBeLessThanOrEqual(700);
    expect(rendered).toContain("decision number 29");
    expect(rendered).toContain("omitted for space");
    expect(rendered).toContain("decision number 0");
    expect(renderDirectives([], 600)).toBe("");
  });

  it("flows through prepareSummaryInputs into the rendered sections", () => {
    const prepared = prepareSummaryInputs({ messages });
    const sections = renderSections({ pinned: [], cleared: [], state: [], directives: prepared.directives });
    expect(sections).toContain("Operator and user directives");
    expect(sections).toContain("stg-db-03");
  });
});

describe("directive ranking", () => {
  it("keeps instruction-like and short messages ahead of long filler prose", () => {
    const filler = (n: number) => ({ source: "user" as const, text: `Next, let's talk about topic ${n}. ${"lorem ipsum dolor sit amet ".repeat(10)}` });
    const rule = { source: "user" as const, text: "Also, do not email Priya about the budget before Friday 2026-04-10." };
    const items = [filler(1), filler(2), rule, ...Array.from({ length: 12 }, (_, i) => filler(i + 3))];
    const rendered = renderDirectives(items, 1200);
    expect(rendered).toContain("before Friday 2026-04-10");
    expect(rendered).toContain("omitted for space");
  });
});
