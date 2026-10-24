import { describe, expect, it } from "vitest";
import { extractPinnedFacts, renderPinned } from "../src/compaction/pin.js";
import {
  mergePinned,
  prepareSummaryInputs,
  redactMessages,
  renderSections,
  SECTIONS_MARKER,
  splitSummary,
} from "../src/compaction/summarize.js";

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
