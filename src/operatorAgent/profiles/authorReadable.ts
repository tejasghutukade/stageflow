const DOC_ROOTS = new Set(["docs", "policies"]);
const ROOT_FILES = new Set(["AGENTS.md", "README.md"]);

/** Relative project path the agent author may read. Null when it is documentation. */
export function authorReadRefusal(rel: string): string | null {
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return "path is outside the readable project surface";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((part) => part === ".git" || part === "node_modules" || part.startsWith("."))) {
    return "path is outside the readable project surface";
  }
  if (ROOT_FILES.has(normalized)) return null;
  const [head, ...rest] = segments;
  if (!head || !DOC_ROOTS.has(head)) {
    return "only documentation under docs/ and policies/, plus AGENTS.md and README.md, can be read";
  }
  if (rest.length === 0) return "path must be a documentation file";
  const base = rest[rest.length - 1] ?? "";
  if (!base.endsWith(".md") && !base.endsWith(".txt")) {
    return "only .md and .txt documentation can be read";
  }
  return null;
}
