import { describe, expect, it } from "vitest";
import { extractPinnedFacts, renderPinned } from "../src/compaction/pin.js";
import {
  composeCompactionSummary,
  mergePinned,
  prepareSummaryInputs,
  readStageflowDetails,
  redactMessages,
  renderSections,
  SECTIONS_MARKER,
  splitSummary,
} from "../src/compaction/summarize.js";
import { COMPACTION_PROMPT_VERSION } from "../src/compaction/types.js";
import type { IndependenceLevel } from "../src/types/stage.js";

const COOKIE = "sf_c00kie_9f8e7d6c5b4a3210";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.FAKE-PAYLOAD-7731.sig_93ab1c";

const browserResult = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "bash",
  isError: false,
  content: [{ type: "text", text: `HTTP/1.1 200 OK\nSet-Cookie: session=${COOKIE}; Path=/; HttpOnly\nAuthorization: ${BEARER}\norder ORD-88213 total=41.50 confirmation=CONF-7781` }],
};

describe("secrets never reach pins or the summarizer", () => {
  it("does not pin cookies, session values or bearer tokens", () => {
    const text = renderPinned(extractPinnedFacts([browserResult]), 4000);
    expect(text).not.toContain(COOKIE);
    expect(text).not.toContain("FAKE-PAYLOAD-7731");
    expect(text).toContain("ORD-88213");
  });

  it("redacts message text, thinking and tool-call arguments for the summarizer", () => {
    const messages = [
      browserResult,
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: `curl -H "Cookie: session=${COOKIE}" https://x` } }, { type: "thinking", thinking: `the token is ${BEARER}` }] },
    ];
    const blob = JSON.stringify(redactMessages(messages));
    expect(blob).not.toContain(COOKIE);
    expect(blob).not.toContain("FAKE-PAYLOAD-7731");
    expect(blob).toContain("ORD-88213");
    expect(JSON.stringify(messages)).toContain(COOKIE);
  });

  it("prepareSummaryInputs hands the summarizer redacted text and keeps pins clean", () => {
    const prepared = prepareSummaryInputs({ messages: [browserResult] });
    expect(JSON.stringify(prepared.messagesForSummarizer)).not.toContain(COOKIE);
    expect(JSON.stringify(prepared.pinned)).not.toContain(COOKIE);
  });
});

describe("summary sections", () => {
  it("splits a summary at the marker and renders nothing when there is nothing to add", () => {
    expect(splitSummary("core text")).toEqual({ core: "core text", sections: "" });
    const withSections = `core\n\n${renderSections({
      pinned: [{ kind: "id", value: "INC-1", context: "incident INC-1", source: { messageIndex: 0 } }],
      cleared: [],
      state: [],
    })}`;
    const split = splitSummary(withSections);
    expect(split.core).toBe("core");
    expect(split.sections.startsWith(SECTIONS_MARKER)).toBe(true);
    expect(renderSections({ pinned: [], cleared: [], state: [] })).toBe("");
  });

  it("merges pinned facts newest first without duplicates and within the cap", () => {
    const f = (value: string) => ({ kind: "id" as const, value, context: value, source: { messageIndex: 0 } });
    const merged = mergePinned([f("A"), f("B")], [f("C"), f("A")], 3);
    expect(merged.map((x) => x.value)).toEqual(["C", "A", "B"]);
    expect(mergePinned([f("A"), f("B")], [f("C")], 2).map((x) => x.value)).toEqual(["C", "A"]);
  });
});

describe("details round trip", () => {
  it("splits on the last marker at the start of a line, even when the model echoed one", () => {
    const echoed = `model text mentions ${SECTIONS_MARKER} inline\n${SECTIONS_MARKER}\n## Pinned facts\n- X`;
    const split = splitSummary(`core\n${echoed}`);
    expect(split.core).toBe(`core\nmodel text mentions ${SECTIONS_MARKER} inline`);
    expect(split.sections.startsWith(SECTIONS_MARKER)).toBe(true);
    expect(splitSummary(`${SECTIONS_MARKER}\n## Pinned facts`)).toEqual({ core: "", sections: `${SECTIONS_MARKER}\n## Pinned facts` });
  });

  it("keeps only well-formed details from a session entry", () => {
    const good = { kind: "id", value: "INC-1", context: "c", source: { messageIndex: 0 } };
    const details = readStageflowDetails({
      readFiles: ["a", 3],
      modifiedFiles: "nope",
      stageflowPinned: [good, { kind: "bogus", value: "x" }, null],
      stageflowCleared: [{ toolName: "read" }],
      stageflowDirectives: [{ source: "operator", text: "ok" }, { source: "alien", text: "no" }],
      stageflowPromptVersion: 1,
    });
    expect(details).toEqual({
      readFiles: ["a"],
      stageflowPinned: [good],
      stageflowCleared: [],
      stageflowDirectives: [{ source: "operator", text: "ok" }],
      stageflowPromptVersion: 1,
    });
    expect(readStageflowDetails("garbage")).toBeUndefined();
    expect(readStageflowDetails(null)).toBeUndefined();
  });

  it("composes one summary: scrubbed text, no echoed marker, sections appended, stripped previous summary", async () => {
    const calls: Array<{ previousSummary: string | undefined; blob: string }> = [];
    const out = await composeCompactionSummary({
      messages: [browserResult],
      previousSummary: `old core\n\n${SECTIONS_MARKER}\n## Pinned facts\n- OLD`,
      previousDetails: {
        stageflowPromptVersion: COMPACTION_PROMPT_VERSION,
        stageflowPinned: [{ kind: "id", value: "OLD-1", context: "old", source: { messageIndex: 0 } }],
      },
      state: [{ key: "next", kind: "todo", value: "read shard 4", updatedAt: "2026-03-14T00:00:00Z" }],
      summarize: async ({ messages, previousSummary }) => {
        calls.push({ previousSummary, blob: JSON.stringify(messages) });
        return { summary: `## Goal\nreview ${SECTIONS_MARKER} Authorization: ${BEARER}` };
      },
    });
    expect(calls[0]!.previousSummary).toBe("old core");
    expect(calls[0]!.blob).not.toContain(COOKIE);
    expect(out.summary.match(new RegExp(SECTIONS_MARKER, "g"))).toHaveLength(1);
    expect(out.summary).not.toContain("FAKE-PAYLOAD-7731");
    expect(out.summary).toContain("ORD-88213");
    expect(out.summary).toContain("OLD-1");
    expect(out.summary).toContain("read shard 4");
  });
});

describe("compaction summary reuse across independence levels", () => {
  async function summarized(input: {
    independence?: IndependenceLevel;
    previousSummary?: string;
    previousDetails?: { stageflowPromptVersion?: number; stageflowIndependence?: IndependenceLevel };
  }) {
    const calls: Array<string | undefined> = [];
    await composeCompactionSummary({
      messages: [],
      ...(input.independence !== undefined ? { independence: input.independence } : {}),
      ...(input.previousSummary !== undefined ? { previousSummary: input.previousSummary } : {}),
      ...(input.previousDetails !== undefined ? { previousDetails: input.previousDetails } : {}),
      state: [],
      summarize: async ({ previousSummary }) => {
        calls.push(previousSummary);
        return { summary: "next" };
      },
    });
    return calls[0];
  }

  it("reads a recorded independence level back with the prompt version", () => {
    expect(
      readStageflowDetails({
        stageflowPromptVersion: COMPACTION_PROMPT_VERSION,
        stageflowIndependence: "open",
      }),
    ).toMatchObject({
      stageflowPromptVersion: COMPACTION_PROMPT_VERSION,
      stageflowIndependence: "open",
    });
    expect(readStageflowDetails({ stageflowIndependence: "loose" })?.stageflowIndependence).toBeUndefined();
  });

  it("passes a previous summary recorded at the same level and version", async () => {
    for (const level of ["strict", "persistent", "open"] as const) {
      expect(
        await summarized({
          independence: level,
          previousSummary: `keep going\n\n${SECTIONS_MARKER}\n## Pinned facts`,
          previousDetails: {
            stageflowPromptVersion: COMPACTION_PROMPT_VERSION,
            stageflowIndependence: level,
          },
        }),
      ).toBe("keep going");
    }
  });

  it("does not pass a previous summary recorded at a different level", async () => {
    const cases: Array<[IndependenceLevel, IndependenceLevel]> = [
      ["strict", "persistent"],
      ["strict", "open"],
      ["persistent", "open"],
    ];
    for (const [recorded, current] of cases) {
      expect(
        await summarized({
          independence: current,
          previousSummary: "dead end",
          previousDetails: {
            stageflowPromptVersion: COMPACTION_PROMPT_VERSION,
            stageflowIndependence: recorded,
          },
        }),
      ).toBeUndefined();
    }
  });

  it("does not pass a previous summary recorded at a different prompt version", async () => {
    expect(
      await summarized({
        independence: "strict",
        previousSummary: "old focus",
        previousDetails: {
          stageflowPromptVersion: COMPACTION_PROMPT_VERSION - 1,
          stageflowIndependence: "strict",
        },
      }),
    ).toBeUndefined();
  });

  it("keeps an agent previous summary when no independence level was recorded", async () => {
    expect(
      await summarized({
        previousSummary: "agent core",
        previousDetails: { stageflowPromptVersion: COMPACTION_PROMPT_VERSION },
      }),
    ).toBe("agent core");
  });
});
