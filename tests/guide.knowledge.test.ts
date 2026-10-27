import { describe, expect, it } from "vitest";
import {
  findGuideKnowledge,
  GUIDE_KNOWLEDGE_TOPICS,
  searchGuideKnowledge,
} from "../src/guide/knowledge/index.js";
import { createGuideKnowledgeTools } from "../src/guide/knowledgeTools.js";
import type { OperatorAgentToolContext } from "../src/operatorAgent/types.js";

const ctx: OperatorAgentToolContext = {
  getContext: () => undefined,
  setContext: () => {},
  emitProposal: () => {},
};

function tool(name: string) {
  const found = createGuideKnowledgeTools().find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

describe("guide knowledge topics", () => {
  it("has 10 to 16 topics with unique ids and non-empty fields", () => {
    expect(GUIDE_KNOWLEDGE_TOPICS.length).toBeGreaterThanOrEqual(10);
    expect(GUIDE_KNOWLEDGE_TOPICS.length).toBeLessThanOrEqual(16);
    const ids = GUIDE_KNOWLEDGE_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const topic of GUIDE_KNOWLEDGE_TOPICS) {
      expect(topic.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(topic.title.trim()).not.toBe("");
      expect(topic.summary.trim()).not.toBe("");
      expect(words(topic.body)).toBeGreaterThanOrEqual(300);
    }
  });

  it("covers the required topics", () => {
    for (const id of [
      "overview",
      "pipelines",
      "stages",
      "tasks",
      "agents",
      "triggers",
      "connections",
      "memories",
      "evals",
      "models_and_providers",
      "mcp_skills_browser",
      "best_practices",
      "limitations",
      "troubleshooting",
      "console_map",
    ]) {
      expect(findGuideKnowledge(id)?.id).toBe(id);
    }
  });

  it("does not leak template placeholders or escaped backticks", () => {
    for (const topic of GUIDE_KNOWLEDGE_TOPICS) {
      expect(topic.body).not.toContain("\\`");
      expect(topic.body).not.toContain("undefined");
    }
  });

  it("finds topics by id ignoring case and surrounding space", () => {
    expect(findGuideKnowledge("  Limitations ")?.id).toBe("limitations");
    expect(findGuideKnowledge("nope")).toBeUndefined();
  });
});

describe("searchGuideKnowledge", () => {
  it.each([
    ["schedule trigger cron", "triggers"],
    ["memory cards cover page", "memories"],
    ["judge rubric grader repeats", "evals"],
    ["send_message pinned recipient slack", "connections"],
    ["where is the inbox in the console", "console_map"],
    ["what does stageflow not do", "limitations"],
    ["ask_first approvals sub_agents", "agents"],
    ["route entry clone chain", "pipelines"],
  ])("ranks %s first as %s", (query, expected) => {
    expect(searchGuideKnowledge(query)[0]?.topic.id).toBe(expected);
  });

  it("is deterministic and honours the limit", () => {
    const first = searchGuideKnowledge("pipeline stage model", 2);
    const second = searchGuideKnowledge("pipeline stage model", 2);
    expect(first).toHaveLength(2);
    expect(first.map((match) => match.topic.id)).toEqual(second.map((match) => match.topic.id));
  });

  it("returns nothing for an empty or stop-word query", () => {
    expect(searchGuideKnowledge("")).toEqual([]);
    expect(searchGuideKnowledge("the and of")).toEqual([]);
    expect(searchGuideKnowledge("zzqqxx")).toEqual([]);
  });
});

describe("guide knowledge tools", () => {
  it("exposes list_guide_topics and read_guide_topic", () => {
    expect(createGuideKnowledgeTools().map((entry) => entry.name)).toEqual([
      "list_guide_topics",
      "read_guide_topic",
    ]);
  });

  it("lists every topic without bodies", async () => {
    const result = await tool("list_guide_topics").handler({}, ctx);
    expect(result.ok).toBe(true);
    const topics = (result.content as { topics: Array<Record<string, unknown>> }).topics;
    expect(topics).toHaveLength(GUIDE_KNOWLEDGE_TOPICS.length);
    expect(topics[0]).toEqual({
      id: GUIDE_KNOWLEDGE_TOPICS[0]!.id,
      title: GUIDE_KNOWLEDGE_TOPICS[0]!.title,
      summary: GUIDE_KNOWLEDGE_TOPICS[0]!.summary,
    });
    expect(topics[0]).not.toHaveProperty("body");
  });

  it("reads a topic body by id", async () => {
    const result = await tool("read_guide_topic").handler({ id: "memories" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toMatchObject({ id: "memories", body: findGuideKnowledge("memories")!.body });
  });

  it("returns guide.topic_not_found for an unknown id", async () => {
    const result = await tool("read_guide_topic").handler({ id: "unknown-topic" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("guide.topic_not_found");
  });

  it("returns top matches with excerpts for a query", async () => {
    const result = await tool("read_guide_topic").handler({ query: "webhook signature trigger" }, ctx);
    expect(result.ok).toBe(true);
    const matches = (result.content as { matches: Array<{ id: string; title: string; excerpt: string }> }).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThanOrEqual(3);
    expect(matches[0]!.id).toBe("triggers");
    expect(matches[0]!.excerpt.length).toBeGreaterThan(0);
    expect(matches[0]!.excerpt.length).toBeLessThanOrEqual(260);
  });

  it("prefers id over query and rejects empty arguments", async () => {
    const both = await tool("read_guide_topic").handler({ id: "evals", query: "triggers" }, ctx);
    expect(both.content).toMatchObject({ id: "evals" });
    const none = await tool("read_guide_topic").handler({}, ctx);
    expect(none.ok).toBe(false);
    expect(none.error).toBe("guide.id_or_query_required");
  });
});
