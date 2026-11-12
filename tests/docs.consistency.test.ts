import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isKnownStageflowEnvKey, KNOWN_STAGEFLOW_ENV_KEYS } from "../src/config/hostConfig.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function markdownFiles(dir: string, skip: RegExp[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = path.posix.join(dir, entry);
    if (skip.some((re) => re.test(rel))) continue;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...markdownFiles(rel, skip));
    else if (rel.endsWith(".md")) out.push(rel);
  }
  return out;
}

function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/`/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");
}

function anchorsOf(file: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of read(file).split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const explicit = /\{#([\w-]+)\}\s*$/.exec(match[1]!);
    if (explicit) anchors.add(explicit[1]!);
    const text = match[1]!.replace(/\s*\{#[\w-]+\}\s*$/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Names the env page documents: concrete `STAGEFLOW_*` keys, `_FILE` / `_PER_PROJECT` suffixes, and prefix families ending in `_`. `_EMAIL` beside `*_NAME` is the email variable. */
function stageflowNamesInEnvDoc(doc: string): string[] {
  const names = new Set<string>();
  let previous: string | undefined;
  for (const match of doc.matchAll(/`([^`]+)`/g)) {
    const token = match[1]!;
    if (/^_[A-Z0-9_]+$/.test(token)) {
      if (previous === undefined) continue;
      const expanded =
        token === "_EMAIL" && previous.endsWith("_NAME")
          ? `${previous.slice(0, -"_NAME".length)}_EMAIL`
          : `${previous}${token}`;
      names.add(expanded);
      continue;
    }
    for (const found of token.matchAll(/(?:^|[^A-Za-z0-9_])(STAGEFLOW_[A-Z0-9_]+)/g)) {
      const name = found[1]!;
      names.add(name);
      previous = name;
    }
  }
  return [...names];
}

const DOC_FILES = [
  ...markdownFiles("docs", [/^docs\/(plans|research|tickets|specs|adr)\//]),
  "README.md",
  "CHANGELOG.md",
];

describe("docs", () => {
  it("has no broken relative links or anchors", () => {
    const problems: string[] = [];
    for (const file of DOC_FILES) {
      let inFence = false;
      read(file).split("\n").forEach((line, index) => {
        if (line.startsWith("```")) inFence = !inFence;
        if (inFence) return;
        for (const match of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)/g)) {
          const target = match[1]!;
          if (/^(https?:|mailto:)/.test(target)) continue;
          const [rawPath = "", fragment = ""] = target.split("#");
          const resolved = rawPath ? path.posix.normalize(path.posix.join(path.posix.dirname(file), rawPath)) : file;
          if (!existsSync(path.join(root, resolved))) {
            problems.push(`${file}:${index + 1} missing ${target}`);
          } else if (fragment && resolved.endsWith(".md") && statSync(path.join(root, resolved)).isFile() && !anchorsOf(resolved).has(fragment)) {
            problems.push(`${file}:${index + 1} anchor ${target}`);
          }
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("documents every Host env key the code accepts", () => {
    const doc = read("docs/environment-variables.md");
    const dynamic = (key: string) => key.endsWith("_") || key.includes("*");
    // The page may write a family once: `NAME`, `_FILE` or `NAME`, `_SUFFIX`. `_EMAIL` beside `*_NAME` is that email variable.
    const documented = (key: string) => {
      if (doc.includes(key)) return true;
      if (key.endsWith("_FILE")) return doc.includes(`${key.slice(0, -5)}\``) && doc.includes("`_FILE`");
      if (key.endsWith("_EMAIL")) {
        return doc.includes(`${key.slice(0, -"_EMAIL".length)}_NAME\``) && doc.includes("`_EMAIL`");
      }
      const suffix = /_PER_PROJECT$/.exec(key)?.[0];
      return suffix !== undefined && doc.includes(`\`${suffix}\``);
    };
    const missing = [...KNOWN_STAGEFLOW_ENV_KEYS].filter((key) => !dynamic(key) && !documented(key));
    expect(missing).toEqual([]);
  });

  it("accepts every concrete STAGEFLOW_* name the env page documents", () => {
    const names = stageflowNamesInEnvDoc(read("docs/environment-variables.md"));
    const rejected = names.filter((name) => !isKnownStageflowEnvKey(name));
    expect(names.length).toBeGreaterThan(40);
    expect(rejected).toEqual([]);
  });

  it("documents every agent and project-MCP route", () => {
    const expand = (pattern: string): string[] => {
      const group = /\(([a-z|]+)\)/.exec(pattern);
      if (!group) return [pattern];
      return group[1]!.split("|").flatMap((alt) => expand(pattern.replace(group[0], alt)));
    };
    const fromRegex = (source: string): string[] =>
      expand(source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, ":x").replace(/\(\\d\+\)/g, ":x"));
    const normalise = (text: string) => text.replace(/:\w+|\{\w+\}|<\w+>/g, ":x");

    const agentDoc = normalise(read("docs/agent-api.md"));
    const mcpDoc = normalise(read("docs/mcp-servers.md"));
    const routes = [...read("src/server/agentRoutes.ts").matchAll(/pattern:\s*\/(\^\\\/api[^/\n]*(?:\\\/[^\n]*?)?\$)\/,/g)].flatMap((m) => fromRegex(m[1]!));
    expect(routes.length).toBeGreaterThan(20);
    const mcpRoutes = [
      ...read("src/server/projectMcpRoutes.ts").matchAll(/pathname === "(\/api\/[^"]+)"/g),
      ...read("src/server/projectMcpRoutes.ts").matchAll(/pathname\.match\(\/\^((?:\\\/|[^/])+?)\$\//g),
    ].flatMap((m) => fromRegex(m[1]!).map((r) => r.replace(/\(\/start\|\/complete\)\?/, "")));
    // A table row may write `…/enable`, `…/disable` for sibling routes.
    const inDoc = (doc: string, route: string) => doc.includes(route) || ["...", "…"].some((dots) => doc.includes(`${dots}/${route.split("/").pop()}`));
    const missing = [
      ...routes.filter((route) => !inDoc(agentDoc, route)),
      ...mcpRoutes.filter((route) => !inDoc(mcpDoc, route)),
    ];
    expect(missing).toEqual([]);
  });

  it("pins published image tags and the security support row to package.json", () => {
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    expect(parsed, version).not.toBeNull();
    const minor = `${parsed![1]}.${parsed![2]}`;
    const allowed = new Set([minor, version]);
    const files = ["README.md", ...markdownFiles("docs"), ...markdownFiles("skills")];
    const problems: string[] = [];
    for (const file of files) {
      read(file).split("\n").forEach((line, index) => {
        for (const match of line.matchAll(/ghcr\.io\/tejasghutukade\/stageflow:([^\s`'"]+)/g)) {
          const tag = match[1]!.replace(/[.,);]+$/, "");
          if (tag === "local" || /^[xyz](?:\.[xyz])+$/.test(tag)) continue;
          if (!allowed.has(tag)) problems.push(`${file}:${index + 1} ${tag}`);
        }
      });
    }
    expect(problems).toEqual([]);

    const supported = [...read("SECURITY.md").matchAll(/\|\s*([^|]+?)\s*\|\s*(Yes|No)\s*\|/g)].map((row) => ({
      version: row[1]!.trim(),
      supported: row[2]!,
    }));
    expect(supported).toEqual([
      { version: `${minor}.x`, supported: "Yes" },
      { version: `< ${minor}`, supported: "No" },
    ]);
  });

  it("follows a logs Control token line with docker exec within 3 lines", () => {
    const files = [
      ...DOC_FILES,
      ...markdownFiles("skills"),
      "docker-compose.yml",
    ];
    const problems: string[] = [];
    for (const file of files) {
      const lines = read(file).split("\n");
      lines.forEach((line, index) => {
        if (!/logs.*`Control token/.test(line)) return;
        const window = lines.slice(index, index + 4).join("\n");
        if (!window.includes("docker exec")) {
          problems.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("never claims a stage is kept from the data directory path", () => {
    const files = ["README.md", "SECURITY.md", "CHANGELOG.md", ...markdownFiles("docs"), ...markdownFiles("skills")];
    const problems = files.filter((file) => /data directory path/.test(read(file)));
    expect(problems).toEqual([]);
  });
});
