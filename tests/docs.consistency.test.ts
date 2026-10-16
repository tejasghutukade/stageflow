import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_STAGEFLOW_ENV_KEYS } from "../src/config/hostConfig.js";

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
    // The page may write a family once: `NAME`, `_FILE` or `NAME`, `_SUFFIX`.
    const documented = (key: string) => {
      if (doc.includes(key)) return true;
      if (key.endsWith("_FILE")) return doc.includes(`${key.slice(0, -5)}\``) && doc.includes("`_FILE`");
      const suffix = /_PER_PROJECT$/.exec(key)?.[0];
      return suffix !== undefined && doc.includes(`\`${suffix}\``);
    };
    const missing = [...KNOWN_STAGEFLOW_ENV_KEYS].filter((key) => !dynamic(key) && !documented(key));
    expect(missing).toEqual([]);
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
});
