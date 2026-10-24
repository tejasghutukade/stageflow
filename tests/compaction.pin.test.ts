import { describe, expect, it } from "vitest";
import { extractPinnedFacts, renderPinned } from "../src/compaction/pin.js";

function toolResult(text: string, toolName = "bash") {
  return { role: "toolResult", toolCallId: "c1", toolName, content: [{ type: "text", text }], isError: false };
}

function noiseLines(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = String(i % 60).padStart(2, "0");
    out.push(`2026-03-14T05:${s}:${s}Z INFO payments-api request handled path=/v1/charge latency_ms=${20 + (i % 7)} ok`);
  }
  return out;
}

function planted(): string {
  const lines = noiseLines(600);
  lines.splice(100, 0, "2026-03-14T04:12:44Z WARN incident INC-4471 opened for checkout degradation");
  lines.splice(250, 0, "deploy finished build 9f3c2ab41d7e for release candidate");
  lines.splice(400, 0, "affected_orders=48211 across the region");
  lines.splice(500, 0, "service recovered at 05:52:03 UTC after rollback");
  return lines.join("\n");
}

describe("extractPinnedFacts", () => {
  it("pins planted facts among noise and ranks them above noise", () => {
    const facts = extractPinnedFacts([toolResult(planted())]);
    const values = facts.map((f) => f.value);
    expect(values).toContain("INC-4471");
    expect(values).toContain("9f3c2ab41d7e");
    expect(values).toContain("affected_orders=48211");
    expect(values.some((v) => v.includes("05:52:03"))).toBe(true);
    const top = values.slice(0, 8).join("|");
    expect(top).toContain("INC-4471");
    expect(top).toContain("affected_orders=48211");
    expect(facts.filter((f) => f.value.startsWith("latency_ms=")).length).toBe(0);
  });

  it("captures error lines with top rank", () => {
    const text = [...noiseLines(50), "ERROR connection refused to ledger-db:5432 exit code 2"].join("\n");
    const facts = extractPinnedFacts([toolResult(text)]);
    expect(facts[0]!.kind).toBe("error");
    expect(facts[0]!.value).toContain("connection refused");
  });

  it("extracts urls, paths, uuids, tickets and percentages from user messages", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "See https://example.com/runbook/db?id=7 and /var/log/app/out.log, src/a/b.ts. run 3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab PLAT-902 PR #118 saw 12.5% loss, cost $1,200.50" }],
    };
    const assistant = { role: "assistant", content: [{ type: "text", text: "FAKE-999 is mine" }] };
    const facts = extractPinnedFacts([user, assistant]);
    const values = facts.map((f) => f.value);
    expect(values).toEqual(
      expect.arrayContaining([
        "https://example.com/runbook/db?id=7",
        "/var/log/app/out.log",
        "src/a/b.ts",
        "3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab",
        "PLAT-902",
        "PR #118",
        "12.5%",
        "$1,200.50",
      ]),
    );
    expect(values).not.toContain("FAKE-999");
    expect(facts.find((f) => f.value === "PLAT-902")!.source.messageIndex).toBe(0);
  });

  it("dedupes and counts repeated values", () => {
    const text = "retry for INC-1 failed\nlater INC-1 still open\nand INC-1 again";
    const facts = extractPinnedFacts([toolResult(text)]);
    const inc = facts.filter((f) => f.value === "INC-1");
    expect(inc).toHaveLength(1);
    expect(inc[0]!.count).toBe(3);
  });

  it("is deterministic", () => {
    const msgs = [toolResult(planted())];
    expect(extractPinnedFacts(msgs)).toEqual(extractPinnedFacts(msgs));
  });

  it("handles 1 MB input quickly", () => {
    const lines: string[] = [];
    let size = 0;
    for (let i = 0; size < 1_000_000; i++) {
      const l = `${i} word${"abcdefghij"[i % 10]}${"klmnopqrst"[(i >> 3) % 10]}${"uvwxyzabcd"[(i >> 6) % 10]} user=u${i} path /srv/data/f${i}.csv took ${i % 90} ms status ok TK-${i}`;
      lines.push(l);
      size += l.length + 1;
    }
    const msgs = [toolResult(lines.join("\n"))];
    const start = performance.now();
    const facts = extractPinnedFacts(msgs);
    expect(performance.now() - start).toBeLessThan(200);
    expect(facts.length).toBeGreaterThan(100);
    const noise = [toolResult(noiseLines(12_000).join("\n"))];
    expect(extractPinnedFacts(noise)).toHaveLength(0);
    const one = [toolResult("x".repeat(1_000_000))];
    const t2 = performance.now();
    extractPinnedFacts(one);
    expect(performance.now() - t2).toBeLessThan(200);
  });
});

describe("renderPinned", () => {
  const secretText = [
    "calling api with api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdef1234567890abcdef.tokenpart",
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed with error 401",
    "visit https://x.test/cb?token=SECRETVALUE123 for INC-77",
  ].join("\n");

  it("never renders secrets", () => {
    const out = renderPinned(extractPinnedFacts([toolResult(secretText)]), 4000);
    expect(out).not.toMatch(/sk-abcdef|abcdef1234567890|ghp_|SECRETVALUE123/);
    expect(out).toContain("INC-77");
  });

  it("groups by kind, respects maxChars, never cuts lines, reports omitted", () => {
    const facts = extractPinnedFacts([toolResult(planted())]);
    for (const max of [120, 300, 600, 2000]) {
      const out = renderPinned(facts, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.startsWith("## Pinned facts")).toBe(true);
      const last = out.split("\n").at(-1)!;
      expect(last).toMatch(/^- \(\d+ more omitted\)$/);
      for (const line of out.split("\n")) expect(line).toMatch(/^(## |### |- )/);
    }
    const big = renderPinned(facts, 100_000);
    expect(big).toContain("### Identifiers");
    expect(big).toMatch(/\(0 more omitted\)$/);
    expect(big).toContain("- INC-4471 — ");
  });

  it("renders single-line context", () => {
    const out = renderPinned(extractPinnedFacts([toolResult("a\tb INC-5   \t c")]), 1000);
    expect(out.split("\n").filter((l) => l.includes("INC-5"))).toHaveLength(1);
  });
});
