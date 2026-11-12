import { describe, expect, it } from "vitest";
import {
  accessFromCapabilities,
  deriveAccess,
  describeDeclaration,
  formatAccessDeclaration,
  readAccessDeclaration,
  writeAccessDeclaration,
  type FunctionAccessDeclaration,
} from "../src/functions/accessDeclaration.js";

const MARKER = "__stageflowAccessRan";

function at(source: string, needle: string): { line: number; column: number } {
  const index = source.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  const line = source.slice(0, index).split("\n").length;
  const lastBreak = source.lastIndexOf("\n", index - 1);
  return { line, column: index - lastBreak };
}

function declared(source: string) {
  const read = readAccessDeclaration(source);
  expect(read.present).toBe(true);
  if (!read.present || !read.ok) throw new Error(JSON.stringify(read));
  return read;
}

function rejected(source: string) {
  const read = readAccessDeclaration(source);
  expect(read.present).toBe(true);
  if (!read.present || read.ok) throw new Error(JSON.stringify(read));
  return read.issues;
}

const FULL: FunctionAccessDeclaration = {
  artifacts: "read",
  workspace: "write",
  files: [{ root: "artifacts", path: "reports/summary.md", access: "read" }],
  env: [
    { name: "MIN_SCORE", optional: false },
    { name: "REGION", optional: true },
  ],
  network: [
    { origin: "https://api.example.com", effect: "read", methods: ["GET"], path: "/" },
    {
      origin: "https://hooks.example.com:8443",
      effect: "action",
      methods: ["POST"],
      path: "/v1",
      credential: "hooks.token",
    },
  ],
};

describe("access declaration parser", () => {
  it("accepts comments, quotes, keys, trailing commas, env markers, files, and network forms", () => {
    const source = `
// header
/* block
   comment */
export const access = {
  artifacts: "read", // inline
  workspace: 'write',
  files: [
    { root: "artifacts", path: "reports/summary.md", access: "read", },
    { "root": 'workspace', "path": "notes.txt", "access": "write" },
  ],
  env: ["MIN_SCORE", 'REGION?',],
  network: [
    "https://api.example.com",
    { origin: "https://hooks.example.com", effect: "action", methods: ["POST"], path: "/v1", credential: "hooks.token" },
  ],
};
export default function execute(context) {
  return { passed: true };
}
`;
    const read = declared(source);
    expect(read.access).toEqual({
      artifacts: "read",
      workspace: "write",
      files: [
        { root: "artifacts", path: "reports/summary.md", access: "read" },
        { root: "workspace", path: "notes.txt", access: "write" },
      ],
      env: [
        { name: "MIN_SCORE", optional: false },
        { name: "REGION", optional: true },
      ],
      network: [
        { origin: "https://api.example.com", effect: "read", methods: ["GET"], path: "/" },
        {
          origin: "https://hooks.example.com",
          effect: "action",
          methods: ["POST"],
          path: "/v1",
          credential: "hooks.token",
        },
      ],
    });
    expect(source.slice(read.range.start, read.range.end)).toBe(source.slice(source.indexOf("export const access"), source.indexOf("};") + 2));
  });

  it("fills defaults when keys are omitted", () => {
    const read = declared("export const access = {};\nexport default function execute(){ return { passed: true }; }\n");
    expect(read.access).toEqual({
      artifacts: "none",
      workspace: "none",
      files: [],
      env: [],
      network: [],
    });
  });

  it("accepts string escapes and identifier keys", () => {
    const source = 'export const access = { "artifacts": "read", env: ["A\\nB"], network: [] };\n';
    const read = declared(source);
    expect(read.access.env).toEqual([{ name: "A\nB", optional: false }]);
  });

  it("rejects non-literal syntax with a line and column", () => {
    const cases: Array<{ source: string; needle: string; message: string }> = [
      {
        source: "export const access = { ...base, env: [], network: [] };\n",
        needle: "...",
        message: "spread is not allowed in an access declaration",
      },
      {
        source: 'export const access = { ["artifacts"]: "read", env: [], network: [] };\n',
        needle: "[",
        message: "computed keys are not allowed in an access declaration",
      },
      {
        source: "export const access = { artifacts: `read`, env: [], network: [] };\n",
        needle: "`",
        message: "template literals are not allowed in an access declaration",
      },
      {
        source: 'export const access = { artifacts: String("read"), env: [], network: [] };\n',
        needle: "String",
        message: "calls are not allowed in an access declaration",
      },
      {
        source: "export const access = { artifacts: read, env: [], network: [] };\n",
        needle: "read",
        message: "only literals are allowed in an access declaration",
      },
      {
        source: 'export const access = { artifacts: "read", shell: true, env: [], network: [] };\n',
        needle: "shell",
        message: 'unknown access key "shell"',
      },
      {
        source: 'export const access = { artifacts: "read", artifacts: "none", env: [], network: [] };\n',
        needle: "artifacts: \"none\"",
        message: 'duplicate access key "artifacts"',
      },
      {
        source: "export const access = { artifacts: 1, env: [], network: [] };\n",
        needle: "1",
        message: "artifacts must be a string",
      },
      {
        source: 'export const access = { artifacts: "all", env: [], network: [] };\n',
        needle: '"all"',
        message: 'artifacts must be "none", "read", or "write"',
      },
    ];
    for (const item of cases) {
      const issues = rejected(item.source);
      expect(issues[0]).toMatchObject({ message: item.message, ...at(item.source, item.needle) });
    }
  });

  it("rejects a declaration that is not the first statement and a second declaration", () => {
    const later = "export default function execute(){ return { passed: true }; }\nexport const access = { artifacts: \"none\", env: [], network: [] };\n";
    const laterIssues = rejected(later);
    expect(laterIssues[0]).toEqual({ message: "access must be the first statement in the file", ...at(later, "export const access") });

    const twice = 'export const access = { artifacts: "none", env: [], network: [] };\nexport let access = 1;\n';
    const twiceIssues = rejected(twice);
    expect(twiceIssues[0]).toEqual({ message: "access must be the first statement in the file", ...at(twice, "export let access") });

    const wrongForm = "export var access = { artifacts: \"none\" };\n";
    expect(rejected(wrongForm)[0]?.message).toBe("access must be the first statement in the file");
  });

  it("ignores an access export that is only a comment or a string", () => {
    const source = "// export const access = { artifacts: \"read\" };\nexport default function execute(){ return { passed: true }; }\n";
    expect(readAccessDeclaration(source)).toEqual({ present: false });
    const quoted = "export default function execute(){ return \"export const access\"; }\n";
    expect(readAccessDeclaration(quoted)).toEqual({ present: false });
  });

  it("reports an exact range and rewrites only that statement", () => {
    const prefix = "// keep\n";
    const statement = 'export const access = {\n  artifacts: "read",\n  env: ["MIN_SCORE"],\n  network: [],\n};';
    const rest = "\nexport default function execute(context) {\n  return { passed: context.env.MIN_SCORE };\n}\n";
    const source = prefix + statement + rest;
    const read = declared(source);
    expect(source.slice(read.range.start, read.range.end)).toBe(statement);
    const next = writeAccessDeclaration(source, { ...read.access, artifacts: "none" });
    expect(next.startsWith(prefix)).toBe(true);
    expect(next.endsWith(rest)).toBe(true);
    expect(next.slice(prefix.length, next.length - rest.length)).toBe(formatAccessDeclaration({ ...read.access, artifacts: "none" }));
    const absent = "export default function execute(){ return { passed: true }; }\n";
    const inserted = writeAccessDeclaration(absent, read.access);
    expect(inserted.endsWith(`\n\n${absent}`)).toBe(true);
    expect(inserted.slice(0, inserted.length - absent.length - 2)).toBe(formatAccessDeclaration(read.access));
  });

  it("round-trips format and derive", () => {
    const text = formatAccessDeclaration(FULL);
    const read = declared(`${text}\nexport default function execute(){ return { passed: true }; }\n`);
    expect(read.access).toEqual(FULL);
    const derived = deriveAccess(FULL, "tool");
    expect(accessFromCapabilities(derived.capabilities, derived.bindings)).toEqual(FULL);
    expect(deriveAccess(accessFromCapabilities(derived.capabilities, derived.bindings), "tool")).toEqual(derived);
    expect(describeDeclaration(FULL)).toEqual([
      "Read artifacts",
      "Read and write workspace",
      "Read artifacts reports/summary.md",
      "Env MIN_SCORE",
      "Env REGION (optional)",
      "API https://api.example.com (read)",
      "API https://hooks.example.com:8443 (action)",
    ]);
  });

  it("round-trips every capability shape through derived ids", () => {
    const shapes: FunctionAccessDeclaration = {
      artifacts: "read",
      workspace: "write",
      files: [
        { root: "workspace", path: "src/app.ts", access: "read" },
        { root: "artifacts", path: "", access: "read" },
      ],
      env: [
        { name: "MIN_SCORE", optional: false },
        { name: "REGION", optional: true },
      ],
      network: [
        { origin: "https://api.example.com", effect: "read", methods: ["GET"], path: "/" },
        {
          origin: "https://hooks.example.com",
          effect: "action",
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          path: "/",
          credential: "hooks",
        },
        {
          origin: "https://files.example.com",
          effect: "read",
          methods: ["GET", "HEAD"],
          path: "/v2",
          credential: "files.reader",
        },
      ],
    };
    const derived = deriveAccess(shapes, "tool");
    expect(accessFromCapabilities(derived.capabilities, derived.bindings)).toEqual(shapes);
    expect(deriveAccess(accessFromCapabilities(derived.capabilities, derived.bindings), "verification")).toEqual(derived);
    expect(derived.capabilities).toEqual([
      { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" },
      { id: "workspace", type: "file", root: "workspace", path: "", access: "write" },
      { id: "file_workspace_src_app_ts", type: "file", root: "workspace", path: "src/app.ts", access: "read" },
      { id: "file_artifacts", type: "file", root: "artifacts", path: "", access: "read" },
      { id: "env_min_score", type: "env", alias: "MIN_SCORE" },
      { id: "env_region", type: "env", alias: "REGION" },
      { id: "api_api_example_com", type: "api", origin: "https://api.example.com", methods: ["GET"], path_prefix: "/", effect: "read" },
      {
        id: "api_hooks_example_com",
        type: "api",
        origin: "https://hooks.example.com",
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        path_prefix: "/",
        effect: "action",
        credential_ref: "hooks",
      },
      {
        id: "api_files_example_com",
        type: "api",
        origin: "https://files.example.com",
        methods: ["GET", "HEAD"],
        path_prefix: "/v2",
        effect: "read",
        credential_ref: "files.reader",
      },
    ]);
    expect(derived.bindings).toEqual([
      { alias: "MIN_SCORE", required: true },
      { alias: "REGION", required: false },
    ]);
  });

  it("keeps capability ids stable when unrelated entries move, and suffixes collisions", () => {
    const first: FunctionAccessDeclaration = {
      artifacts: "none",
      workspace: "none",
      files: [{ root: "artifacts", path: "report.json", access: "read" }],
      env: [{ name: "MIN_SCORE", optional: false }],
      network: [
        { origin: "https://api.example.com", effect: "read", methods: ["GET"], path: "/" },
        { origin: "https://api.example.com", effect: "read", methods: ["GET"], path: "/v1" },
      ],
    };
    const second: FunctionAccessDeclaration = {
      ...first,
      env: [
        { name: "REGION", optional: true },
        { name: "MIN_SCORE", optional: false },
      ],
      files: [
        { root: "workspace", path: "notes.txt", access: "read" },
        { root: "artifacts", path: "report.json", access: "read" },
      ],
    };
    const before = deriveAccess(first, "verification");
    const after = deriveAccess(second, "verification");
    const id = (caps: unknown[], needle: string) =>
      (caps.find((item) => isFile(item) && item.path === needle) as { id: string } | undefined)?.id;
    expect(id(before.capabilities, "report.json")).toBe("file_artifacts_report_json");
    expect(id(after.capabilities, "report.json")).toBe("file_artifacts_report_json");
    expect(deriveAccess(first, "tool")).toEqual(before);
    const network = before.capabilities.filter((item) => isApi(item));
    expect(network.map((item) => item.id)).toEqual(["api_api_example_com", "api_api_example_com_2"]);
    const flipped: FunctionAccessDeclaration = {
      ...first,
      network: [first.network[1]!, first.network[0]!],
    };
    const flippedIds = deriveAccess(flipped, "tool").capabilities.filter(isApi).map((item) => item.id);
    expect(flippedIds).toEqual(["api_api_example_com", "api_api_example_com_2"]);
    const longPath = "p".repeat(80);
    const longId = (deriveAccess(
      {
        artifacts: "none",
        workspace: "none",
        files: [{ root: "artifacts", path: longPath, access: "read" }],
        env: [],
        network: [],
      },
      "tool",
    ).capabilities[0] as { id: string }).id;
    expect(longId).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(longId.length).toBeLessThanOrEqual(64);
    expect(longId).toContain("_");
  });

  it("does not evaluate a getter or a call", () => {
    const holder = globalThis as Record<string, unknown>;
    delete holder[MARKER];
    const source = `export const access = { artifacts: (globalThis.${MARKER} = true, "read"), env: [], network: [] };\nexport default function execute(){ return {}; }\n`;
    const issues = rejected(source);
    expect(issues[0]?.message).toMatch(/not allowed/);
    expect(holder[MARKER]).toBeUndefined();
    const getter = 'export const access = { get artifacts() { globalThis.__stageflowAccessRan = true; return "read"; }, env: [], network: [] };\n';
    expect(rejected(getter)[0]?.message).toMatch(/getter/);
    expect(holder[MARKER]).toBeUndefined();
  });
});

function isFile(value: unknown): value is { id: string; path: string } {
  return !!value && typeof value === "object" && (value as { type?: string }).type === "file";
}

function isApi(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && (value as { type?: string }).type === "api";
}
