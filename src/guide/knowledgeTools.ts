import { Type } from "typebox";
import type { OperatorAgentTool, OperatorAgentToolResult } from "../operatorAgent/types.js";
import { findGuideKnowledge, GUIDE_KNOWLEDGE_TOPICS, searchGuideKnowledge } from "./knowledge/index.js";

const SEARCH_LIMIT = 3;

function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failure(error: string, content: Record<string, unknown> = {}): OperatorAgentToolResult {
  return { ok: false, content: { error, ...content }, error };
}

export function createGuideKnowledgeTools(): OperatorAgentTool[] {
  return [
    {
      name: "list_guide_topics",
      description:
        "List the Stageflow knowledge topics (id, title, summary). Read a topic with read_guide_topic before you explain how a part of Stageflow works, recommend a design, or say whether something is possible.",
      parameters: Type.Object({}, { additionalProperties: false }),
      handler: () => ({
        ok: true,
        content: {
          topics: GUIDE_KNOWLEDGE_TOPICS.map(({ id, title, summary }) => ({ id, title, summary })),
        },
      }),
    },
    {
      name: "read_guide_topic",
      description:
        "Read Stageflow knowledge. Pass { id } to get a topic's full text (ids from list_guide_topics), or { query } to get the best matching topics with a short excerpt. Prefer the limitations topic before promising a feature.",
      parameters: Type.Union([
        Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        Type.Object({ query: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      ]),
      handler: (args) => {
        const id = textArg(args, "id");
        if (id !== undefined) {
          const topic = findGuideKnowledge(id);
          if (!topic) {
            return failure("guide.topic_not_found", {
              id,
              topics: GUIDE_KNOWLEDGE_TOPICS.map((entry) => entry.id),
            });
          }
          return { ok: true, content: { id: topic.id, title: topic.title, body: topic.body } };
        }
        const query = textArg(args, "query");
        if (query !== undefined) {
          const matches = searchGuideKnowledge(query, SEARCH_LIMIT).map(({ topic, excerpt }) => ({
            id: topic.id,
            title: topic.title,
            excerpt,
          }));
          return { ok: true, content: { query, matches } };
        }
        return failure("guide.id_or_query_required");
      },
    },
  ];
}
