import { createParser, type ASTNode } from "../src/artifacts/library/langCore.js";
import { libraryJsonSchema } from "../src/artifacts/library/index.js";
import "../src/artifacts/library/telemetryEnv.js";
import { reconcileProgram, validateProgram } from "../src/artifacts/program.js";
import { describe, expect, it } from "vitest";

const bindings = [{ id: "rows", function: "get_usage", args: { range: "7" } }];
const schemas = new Map([["get_usage", { outputSchema: undefined }]]);
const bound = new Set(["get_usage"]);
const invisibles = ["\u200B", "\u200C", "\u200D", "\u200E", "\u200F", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064", "\uFEFF", "\u00A0", "\u000B", "\u000C", "\u0085", "\u2028", "\u2029", "\\"];
const parser = createParser(libraryJsonSchema(), "Stack");

const smuggled = [
  'd = Query("get_usage" + "_evil", {})\nroot = TextContent("x")',
  'd = Query("get_usage" || "evil", {})\nroot = TextContent("x")',
  'd = Query("get_usage" ?? "evil", {})\nroot = TextContent("x")',
  'd = Query("get_usage" == "x" ? "evil" : "get_usage", {})\nroot = TextContent("x")',
  'd = @Query("evil", {})\nroot = TextContent("x")',
  'd = Query("get_usag\\e", {})\nroot = TextContent("x")',
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const bases = [
  'root = TextContent("hello")',
  'data = Query("get_usage", {range: "7"}, {rows: []})\nroot = TextContent("x")',
  '$range = "7"\ndata = Query("get_usage", {range: $range}, {rows: []})\nrows = data.rows\nnote = rows.day\nroot = TextContent("ok")',
  'header = CardHeader("Usage", "Events")\ndata = Query("get_usage", {range: "7"}, {rows: []})\nroot = Stack([header, TextContent("x")])',
];

function mutate(source: string, roll: number, rng: () => number): string {
  const mark = invisibles[Math.floor(rng() * invisibles.length)]!;
  if (roll === 0) return source.replace('Query("get_usage"', 'Query("get_usage" + "_x"');
  if (roll === 1) return source.replace("Query(", "@Query(");
  if (roll === 2) return source.replaceAll("get_usage", "get_usag\\e");
  if (roll === 3) return source.replace("Query(", "Query( // kept\n");
  if (roll === 4) return source.replace('TextContent("', 'TextContent("héllo ');
  if (roll === 5) return source.replace("Query(", "Query(\n  ");
  if (roll === 6) return `shadow = TextContent("get_usage")\n${source}`;
  if (roll === 7) return source.replace("Query(", `Query${mark}\n(`);
  if (roll === 8) return source.replace("@", `@${mark}`);
  if (roll === 9) return source.replace("==", `=${mark}=`).replace("?", `?${mark}`).replace("+", `+${mark}`);
  if (!source.includes("data.rows")) return `${source}\nalias = data`;
  return source.replace("rows = data.rows", "alias = data.rows\nrows = alias");
}

function toolNames(node: ASTNode | null): string[] | undefined {
  if (!node) return undefined;
  if (node.k === "Str") return [node.v];
  return undefined;
}

function queryToolNames(program: string): string[] | undefined {
  const parsed = parser.parse(program);
  const names: string[] = [];
  const take = (tool: ASTNode | null): boolean => {
    if (!tool) return true;
    const values = toolNames(tool);
    if (!values) return false;
    names.push(...values);
    return true;
  };
  for (const query of parsed.queryStatements) {
    if (!take(query.toolAST)) return undefined;
  }
  for (const mutation of parsed.mutationStatements) {
    if (!take(mutation.toolAST)) return undefined;
  }
  const walk = (current: unknown): boolean => {
    if (!current || typeof current !== "object") return true;
    if (Array.isArray(current)) return current.every(walk);
    const node = current as ASTNode & { type?: string; props?: Record<string, unknown> };
    if (node.k === "Comp" && (node.name === "Query" || node.name === "Mutation")) {
      if (!take(node.args[0] ?? null)) return false;
      return node.args.every(walk);
    }
    if (node.type === "element") return Object.values(node.props ?? {}).every(walk);
    if (node.k === "Comp") return node.args.every(walk);
    if (node.k === "Arr") return node.els.every(walk);
    if (node.k === "Obj") return node.entries.every(([, value]) => walk(value));
    if (node.k === "BinOp") return walk(node.left) && walk(node.right);
    if (node.k === "UnaryOp") return walk(node.operand);
    if (node.k === "Ternary") return walk(node.cond) && walk(node.then) && walk(node.else);
    if (node.k === "Member") return walk(node.obj);
    if (node.k === "Index") return walk(node.obj) && walk(node.index);
    return true;
  };
  if (!walk(parsed.root)) return undefined;
  return names;
}

describe("live program differential", () => {
  it("accepts a program only when every lang-core query names a bound function", () => {
    for (const program of smuggled) {
      const accepted = validateProgram(program).ok && reconcileProgram(program, bindings, schemas).errors.length === 0;
      expect(accepted, program).toBe(false);
    }
    const rng = mulberry32(18);
    let acceptedCount = 0;
    for (let index = 0; index < 20_000; index += 1) {
      const base = bases[Math.floor(rng() * bases.length)]!;
      const program = mutate(base, Math.floor(rng() * 11), rng);
      const accepted = validateProgram(program).ok && reconcileProgram(program, bindings, schemas).errors.length === 0;
      if (!accepted) continue;
      acceptedCount += 1;
      const names = queryToolNames(program);
      expect(names, program).toBeTruthy();
      for (const name of names ?? []) expect(bound.has(name), program).toBe(true);
    }
    expect(acceptedCount).toBeGreaterThan(0);
  }, 60_000);
});
