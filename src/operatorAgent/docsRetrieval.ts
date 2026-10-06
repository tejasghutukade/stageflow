import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DocsRetrievalHit = {
  path: string;
  kind: "doc" | "example";
  title: string;
  excerpt: string;
};

export type DocsRetrievalResult = {
  ok: boolean;
  hits: DocsRetrievalHit[];
  error?: string;
};

export type DocsRetriever = {
  retrieve(
    query: string,
    options?: { kind?: "docs" | "examples" | "any"; limit?: number },
  ): Promise<DocsRetrievalResult>;
};

type CorpusEntry = {
  path: string;
  kind: "doc" | "example";
  title: string;
  topics: string[];
};

const CORPUS: CorpusEntry[] = [
  {
    path: "docs/yaml-catalog.md",
    kind: "doc",
    title: "YAML catalog",
    topics: [
      "yaml",
      "catalog",
      "io",
      "verify",
      "on_verify_fail",
      "route",
      "entry",
      "clone",
      "clone-chain",
      "feedback",
      "loop",
      "mcp",
      "dag",
      "linear",
    ],
  },
  {
    path: "docs/envelopes.md",
    kind: "doc",
    title: "Envelopes",
    topics: ["envelope", "artifacts", "emit", "payload", "summary", "status"],
  },
  {
    path: "docs/hitl.md",
    kind: "doc",
    title: "HITL",
    topics: [
      "hitl",
      "ask_operator",
      "gate",
      "gate_kinds",
      "confirm",
      "free_text",
      "artifact_backed",
    ],
  },
  {
    path: "docs/verified-stage-execution.md",
    kind: "doc",
    title: "Verified stage execution",
    topics: [
      "verify",
      "vse",
      "recovery",
      "repair",
      "manual",
      "on_verify_fail",
      "after",
    ],
  },
  {
    path: "docs/mcp.md",
    kind: "doc",
    title: "MCP",
    topics: ["mcp", "tools", "stageflow", "server"],
  },
  {
    path: "examples/README.md",
    kind: "example",
    title: "Examples index",
    topics: ["examples", "walkthrough", "catalog"],
  },
  {
    path: "examples/hello-world/README.md",
    kind: "example",
    title: "hello-world",
    topics: ["hello", "linear", "task.input", "io"],
  },
  {
    path: "examples/plan-review/README.md",
    kind: "example",
    title: "plan-review",
    topics: ["plan", "review", "hitl", "gate", "multi-stage"],
  },
  {
    path: "examples/conditional-fork/README.md",
    kind: "example",
    title: "conditional-fork",
    topics: ["fork", "route", "if", "branch", "hitl"],
  },
  {
    path: "examples/feedback-loop/README.md",
    kind: "example",
    title: "feedback-loop",
    topics: ["feedback", "loop", "send_back", "continue", "replay"],
  },
  {
    path: "examples/feature-loop/README.md",
    kind: "example",
    title: "feature-loop",
    topics: ["clone", "clone-chain", "loop", "feature", "pr"],
  },
  {
    path: "examples/stage-mcp/README.md",
    kind: "example",
    title: "stage-mcp",
    topics: ["mcp", "stage", ".mcp.json"],
  },
  {
    path: "examples/verify-tour/README.md",
    kind: "example",
    title: "verify-tour",
    topics: ["verify", "artifact", "command", "checklist", "gate"],
  },
  {
    path: "examples/retry-tour/README.md",
    kind: "example",
    title: "retry-tour",
    topics: ["retry", "repair", "manual", "recover", "recovery"],
  },
  {
    path: "skills/stageflow-author/assets/examples/linear-review/review-loop.pipeline.yaml",
    kind: "example",
    title: "linear-review (author skill)",
    topics: ["linear", "review", "author", "skill"],
  },
  {
    path: "skills/stageflow-author/assets/examples/branch-decision/release-gate.pipeline.yaml",
    kind: "example",
    title: "branch-decision (author skill)",
    topics: ["branch", "decision", "route", "if", "author"],
  },
  {
    path: "skills/stageflow-author/assets/examples/non-sdlc-digest/research-digest.pipeline.yaml",
    kind: "example",
    title: "non-sdlc-digest (author skill)",
    topics: ["digest", "non-sdlc", "research", "author"],
  },
];

const EXCERPT_MAX = 1200;

export function resolveWorkshopCatalogRoot(explicit?: string): string {
  if (explicit) return explicit;
  return fileURLToPath(new URL("../..", import.meta.url));
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreEntry(entry: CorpusEntry, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  let score = 0;
  const hay = `${entry.path} ${entry.title} ${entry.topics.join(" ")}`.toLowerCase();
  for (const token of tokens) {
    if (entry.topics.includes(token)) score += 4;
    else if (hay.includes(token)) score += 2;
  }
  return score;
}

async function readExcerpt(absPath: string): Promise<string | null> {
  try {
    const text = await readFile(absPath, "utf8");
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > EXCERPT_MAX
      ? `${trimmed.slice(0, EXCERPT_MAX)}…`
      : trimmed;
  } catch {
    return null;
  }
}

/**
 * Filesystem retriever over public docs/ + examples/ (allowlisted).
 * Read failures for individual paths are skipped; empty matches still ok:true.
 * Thrown/unexpected errors surface as ok:false so the agent can fall back to
 * the baked playbook.
 */
export function createFilesystemDocsRetriever(
  options: { rootDir?: string } = {},
): DocsRetriever {
  const rootDir = resolveWorkshopCatalogRoot(options.rootDir);
  return {
    async retrieve(query, opts = {}) {
      try {
        const kind = opts.kind ?? "any";
        const limit = Math.max(1, Math.min(opts.limit ?? 5, 10));
        const tokens = tokenize(query);
        const ranked = CORPUS.map((entry) => ({
          entry,
          score: scoreEntry(entry, tokens),
        }))
          .filter(({ entry, score }) => {
            if (score <= 0) return false;
            if (kind === "docs") return entry.kind === "doc";
            if (kind === "examples") return entry.kind === "example";
            return true;
          })
          .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));

        const hits: DocsRetrievalHit[] = [];
        for (const { entry } of ranked) {
          if (hits.length >= limit) break;
          const abs = path.join(rootDir, entry.path);
          let excerpt = await readExcerpt(abs);
          if (excerpt === null && entry.path.endsWith("/README.md")) {
            const dir = path.dirname(entry.path);
            const fallback = path.join(rootDir, dir, "README.md");
            excerpt = await readExcerpt(fallback);
          }
          if (excerpt === null) continue;
          hits.push({
            path: entry.path,
            kind: entry.kind,
            title: entry.title,
            excerpt,
          });
        }

        return { ok: true, hits };
      } catch (err) {
        return {
          ok: false,
          hits: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function createStubDocsRetriever(
  impl:
    | DocsRetrievalHit[]
    | ((
        query: string,
        options?: { kind?: "docs" | "examples" | "any"; limit?: number },
      ) => DocsRetrievalResult | Promise<DocsRetrievalResult>),
): DocsRetriever {
  if (typeof impl === "function") {
    return {
      async retrieve(query, options) {
        try {
          return await impl(query, options);
        } catch (err) {
          return {
            ok: false,
            hits: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  }
  return {
    async retrieve() {
      return { ok: true, hits: impl };
    },
  };
}

export function createFailingDocsRetriever(
  error = "docs retrieval unavailable",
): DocsRetriever {
  return {
    async retrieve() {
      return { ok: false, hits: [], error };
    },
  };
}

export { CORPUS as WORKSHOP_DOCS_CORPUS };
