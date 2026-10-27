import { agentsTopic } from "./topics/agents.js";
import { bestPracticesTopic } from "./topics/bestPractices.js";
import { connectionsTopic } from "./topics/connections.js";
import { consoleMapTopic } from "./topics/consoleMap.js";
import { evalsTopic } from "./topics/evals.js";
import { limitationsTopic } from "./topics/limitations.js";
import { mcpSkillsBrowserTopic } from "./topics/mcpSkillsBrowser.js";
import { memoriesTopic } from "./topics/memories.js";
import { modelsAndProvidersTopic } from "./topics/modelsAndProviders.js";
import { overviewTopic } from "./topics/overview.js";
import { pipelinesTopic } from "./topics/pipelines.js";
import { stagesTopic } from "./topics/stages.js";
import { tasksTopic } from "./topics/tasks.js";
import { triggersTopic } from "./topics/triggers.js";
import { troubleshootingTopic } from "./topics/troubleshooting.js";

export type GuideKnowledgeTopic = {
  id: string;
  title: string;
  summary: string;
  body: string;
};

export type GuideKnowledgeMatch = {
  topic: GuideKnowledgeTopic;
  score: number;
  excerpt: string;
};

export const GUIDE_KNOWLEDGE_TOPICS: readonly GuideKnowledgeTopic[] = [
  overviewTopic,
  pipelinesTopic,
  stagesTopic,
  tasksTopic,
  agentsTopic,
  triggersTopic,
  connectionsTopic,
  memoriesTopic,
  evalsTopic,
  modelsAndProvidersTopic,
  mcpSkillsBrowserTopic,
  bestPracticesTopic,
  limitationsTopic,
  troubleshootingTopic,
  consoleMapTopic,
];

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "if",
  "in", "is", "it", "me", "my", "of", "on", "or", "should", "that", "the", "this", "to", "what", "when",
  "where", "which", "who", "why", "with", "you", "your",
]);

const EXCERPT_CHARS = 240;

export function findGuideKnowledge(id: string): GuideKnowledgeTopic | undefined {
  const key = id.trim().toLowerCase();
  return GUIDE_KNOWLEDGE_TOPICS.find((topic) => topic.id === key);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function scoreTopic(topic: GuideKnowledgeTopic, tokens: readonly string[], phrase: string): number {
  const id = topic.id.toLowerCase();
  const title = topic.title.toLowerCase();
  const summary = topic.summary.toLowerCase();
  const body = topic.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (id === token || id.split("_").includes(token)) score += 8;
    score += 5 * Math.min(countOccurrences(title, token), 2);
    score += 3 * Math.min(countOccurrences(summary, token), 3);
    score += Math.min(countOccurrences(body, token), 6);
  }
  if (tokens.length > 1 && phrase.length > 0) {
    if (title.includes(phrase) || summary.includes(phrase)) score += 6;
    else if (body.includes(phrase)) score += 4;
  }
  return score;
}

function excerptFor(body: string, tokens: readonly string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  const start = Math.max(0, at === -1 ? 0 : at - EXCERPT_CHARS / 3);
  let slice = body.slice(start, start + EXCERPT_CHARS);
  if (start > 0) slice = slice.replace(/^\S*\s/, "");
  if (start + EXCERPT_CHARS < body.length) slice = slice.replace(/\s\S*$/, "");
  const text = slice.replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${start + EXCERPT_CHARS < body.length ? "…" : ""}`;
}

export function searchGuideKnowledge(query: string, limit = 3): GuideKnowledgeMatch[] {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const phrase = tokens.join(" ");
  const max = Math.max(1, Math.floor(limit));
  return GUIDE_KNOWLEDGE_TOPICS
    .map((topic, order) => ({ topic, order, score: scoreTopic(topic, tokens, phrase) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map(({ topic, score }) => ({ topic, score, excerpt: excerptFor(topic.body, tokens) }));
}
