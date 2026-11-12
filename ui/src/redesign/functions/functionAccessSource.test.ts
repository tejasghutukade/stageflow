import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { deriveAccess, readAccessDeclaration } from "@stageflow/function-access";
import type { FunctionCapability, FunctionDefinition } from "../../api/functions";
import { FUNCTION_TEMPLATES } from "./functionsPageModel";
import {
  applyDeclaredControl,
  contractSnapshot,
  declaredAccessState,
  definitionPayload,
  emptyDeclaredAccess,
  moveLegacyAccessIntoSource,
} from "./functionAccessSource";

const BODY = "export default function execute(context) {\n  return { passed: true };\n}\n";

const reports: FunctionCapability = { id: "reports", type: "file", root: "workspace", path: "reports/", access: "read" };
const env: FunctionCapability = { id: "min_score", type: "env", alias: "MIN_SCORE" };
const api: FunctionCapability = {
  id: "api_1",
  type: "api",
  origin: "https://api.example.com",
  methods: ["GET", "POST"],
  path_prefix: "/v1",
  effect: "action",
  credential_ref: "vendor.token",
};

describe("function access source helpers", () => {
  it("inserts a declaration and replaces one without touching the rest of the source", () => {
    const inserted = applyDeclaredControl(BODY, {
      ...emptyDeclaredAccess(),
      artifacts: "read",
      env: [{ name: "MIN_SCORE", optional: true }],
    });
    expect(inserted.endsWith(`\n\n${BODY}`)).toBe(true);
    expect(inserted.startsWith("export const access")).toBe(true);
    const replaced = applyDeclaredControl(inserted, {
      ...emptyDeclaredAccess(),
      artifacts: "read",
      files: [{ root: "artifacts", path: "report.json", access: "read" }],
      env: [{ name: "REGION", optional: false }],
    });
    expect(replaced.endsWith(BODY)).toBe(true);
    expect(replaced).toContain("report.json");
    const read = readAccessDeclaration(replaced);
    expect(read.present && read.ok && read.access.files).toEqual([{ root: "artifacts", path: "report.json", access: "read" }]);
    expect(read.present && read.ok && read.access.env).toEqual([{ name: "REGION", optional: false }]);
  });

  it("leaves a broken declaration unchanged", () => {
    const broken = `export const access = { nope: true };\n${BODY}`;
    expect(declaredAccessState(broken, []).mode).toBe("invalid");
    expect(applyDeclaredControl(broken, emptyDeclaredAccess())).toBe(broken);
  });

  it("moves legacy capabilities into a declaration with the same derived access", () => {
    const moved = moveLegacyAccessIntoSource(BODY, [reports, env, api], [{ alias: "MIN_SCORE", required: true }]);
    const read = readAccessDeclaration(moved);
    expect(read.present && read.ok).toBe(true);
    if (!read.present || !read.ok) return;
    expect(deriveAccess(read.access, "tool")).toEqual(deriveAccess(
      {
        artifacts: "none",
        workspace: "none",
        files: [{ root: "workspace", path: "reports/", access: "read" }],
        env: [{ name: "MIN_SCORE", optional: false }],
        network: [{ origin: "https://api.example.com", effect: "action", methods: ["GET", "POST"], path: "/v1", credential: "vendor.token" }],
      },
      "tool",
    ));
    expect(moved.endsWith(BODY)).toBe(true);
    expect(declaredAccessState(BODY, [reports]).mode).toBe("legacy");
    expect(declaredAccessState(BODY, []).mode).toBe("insert");
  });

  it("omits capability lists from a declared payload and keeps them for legacy source", () => {
    const declared: FunctionDefinition = {
      id: "score",
      name: "Score",
      kind: "verification",
      source: applyDeclaredControl(BODY, { ...emptyDeclaredAccess(), artifacts: "read" }),
      timeout_ms: 5000,
      capabilities: [reports],
      bindings: [],
    };
    const payload = definitionPayload(declared);
    expect("capabilities" in payload).toBe(false);
    expect("bindings" in payload).toBe(false);
    const legacy: FunctionDefinition = { ...declared, source: BODY, capabilities: [reports], bindings: [{ alias: "MIN_SCORE", required: true }] };
    expect(definitionPayload(legacy).capabilities).toEqual([reports]);
    expect(contractSnapshot(declared.source, "verification", [reports], []).capabilities).toEqual(
      contractSnapshot(declared.source, "verification", [], []).capabilities,
    );
    expect(contractSnapshot(BODY, "verification", [reports], []).capabilities).toEqual([reports]);
  });

  it("starts each template with a declaration that parses and checks as a module", () => {
    for (const source of Object.values(FUNCTION_TEMPLATES)) {
      const read = readAccessDeclaration(source);
      expect(read.present && read.ok).toBe(true);
      const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8" });
      expect(checked.status).toBe(0);
    }
  });
});
