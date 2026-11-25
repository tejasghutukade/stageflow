import { readFunctionFile } from "../config/loadFunction.js";
import { ArtifactPublishError, LIVE_PROGRAM_MAX_BYTES, type ArtifactIssue } from "./limits.js";
import {
  LIBRARY_NAME,
  LIBRARY_VERSION,
  OPENUI_LANG_FORMAT,
  VOCABULARY_NAMES,
  libraryJsonSchema,
  libraryVersionStatus,
} from "./library/index.js";
import { createParser, type ASTNode, type ParseResult } from "./library/langCore.js";
import type { LiveBinding, LiveManifest } from "./manifest.js";

export const MAX_PROGRAM_STATEMENTS = 2000;
export const MAX_PROGRAM_NESTING = 20;
export const PROGRAM_PARSE_BUDGET_MS = 250;
export const MAX_PROGRAM_ISSUES = 20;
export const MAX_LINE_BYTES = 16 * 1024;
export const MAX_IDENTIFIER_CHARS = 128;
export const MAX_STATEMENT_BYTES = 64 * 1024;
export const MAX_CHAIN_SEGMENTS = 64;
export const MAX_FIELD_ACCESSES = 20_000;
export const MAX_PROGRAM_QUERIES = 64;
export const MAX_STRING_LITERAL_BYTES = 32 * 1024;
export const MAX_LITERAL_ELEMENTS = 5_000;
export const MAX_CONCURRENT_PROGRAM_VALIDATIONS = 2;
export const MAX_QUEUED_PROGRAM_VALIDATIONS = 32;
const FUNCTION_LOAD_BUDGET_MS = 5_000;
const DEADLINE_STRIDE = 64;
const ALLOWED_CALLS = new Set(["Action", "Set", "Reset", "Run"]);

export type ProgramValidationOptions = {
  now?: () => number;
  budgetMs?: number;
};

class ProgramBudgetExceeded extends Error {
  constructor() {
    super("program too complex");
    this.name = "ProgramBudgetExceeded";
  }
}

type Deadline = { tick: () => void; force: () => void };

function createDeadline(options?: ProgramValidationOptions): Deadline {
  const budget = options?.budgetMs ?? PROGRAM_PARSE_BUDGET_MS;
  const now = options?.now ?? (() => performance.now());
  const start = now();
  let steps = 0;
  const sample = () => {
    if (now() - start > budget) throw new ProgramBudgetExceeded();
  };
  return {
    tick() {
      steps += 1;
      if (steps % DEADLINE_STRIDE === 0) sample();
    },
    force: sample,
  };
}

export type ProgramDiagnostic = {
  path: string;
  code: string;
  message: string;
  line: number;
  severity: "error" | "warning";
};

export type ProgramValidation = {
  ok: boolean;
  errors: ProgramDiagnostic[];
  warnings: ProgramDiagnostic[];
  statementCount: number;
};

type Statement = {
  id: string;
  line: number;
  body: string;
};

type QueryCall = {
  statementId: string;
  line: number;
  tool: string | undefined;
  shapeOk: boolean;
  args: Record<string, { literal: boolean; value?: unknown }>;
};

type FieldUse = {
  statementId: string;
  line: number;
  query: string;
  fields: string[];
  display: string;
};

type Scan = {
  statements: Statement[];
  queries: QueryCall[];
  fields: FieldUse[];
  chains: Array<{ statementId: string; line: number; parts: string[] }>;
  mutations: Array<{ statementId: string; line: number }>;
  excluded: ProgramDiagnostic[];
  cycles: boolean;
  statementCount: number;
  structural?: ProgramDiagnostic;
};

const parser = createParser(libraryJsonSchema(), "Stack");

function diagnostic(
  line: number,
  path: string,
  code: string,
  message: string,
  severity: "error" | "warning" = "error",
): ProgramDiagnostic {
  return { line, path, code, message, severity };
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function scanProgram(source: string, deadline: Deadline): Scan {
  deadline.force();
  const structural = structuralLimit(source, deadline);
  if (structural) {
    return {
      statements: [],
      queries: [],
      fields: [],
      chains: [],
      mutations: [],
      excluded: [],
      cycles: false,
      statementCount: 0,
      structural,
    };
  }
  const extracted = extractStatements(source, deadline);
  if (extracted.structural) {
    return {
      statements: [],
      queries: [],
      fields: [],
      chains: [],
      mutations: [],
      excluded: [],
      cycles: false,
      statementCount: 0,
      structural: extracted.structural,
    };
  }
  const statements = extracted.statements;
  const cycles = referenceCycle(statements, deadline);
  const queries: QueryCall[] = [];
  const mutations: Array<{ statementId: string; line: number }> = [];
  const excluded: ProgramDiagnostic[] = [];
  const chains: Array<{ statementId: string; line: number; parts: string[] }> = [];
  let fieldAccesses = 0;
  for (const statement of statements) {
    deadline.tick();
    const found = inspectBody(statement, deadline);
    if (found.structural) {
      return {
        statements,
        queries,
        fields: [],
        chains,
        mutations,
        excluded,
        cycles,
        statementCount: statements.length,
        structural: found.structural,
      };
    }
    queries.push(...found.queries);
    mutations.push(...found.mutations);
    excluded.push(...found.excluded);
    fieldAccesses += found.fieldAccesses;
    if (fieldAccesses > MAX_FIELD_ACCESSES) {
      return {
        statements,
        queries,
        fields: [],
        chains,
        mutations,
        excluded,
        cycles,
        statementCount: statements.length,
        structural: diagnostic(
          statement.line,
          statement.id,
          "too-many-field-accesses",
          `program has more than ${MAX_FIELD_ACCESSES} field accesses`,
        ),
      };
    }
    chains.push(...found.chains);
  }
  const mutationIds = new Set(mutations.map((item) => item.statementId));
  for (const statement of statements) {
    for (const target of runTargets(statement.body)) {
      if (mutationIds.has(target)) {
        excluded.push(
          diagnostic(
            statement.line,
            statement.id,
            "excluded-feature",
            `@Run(${target}) runs a Mutation. Mutations are disabled.`,
          ),
        );
      }
    }
  }
  const fields = resolveFields(statements, queries, chains);
  return {
    statements,
    queries,
    fields,
    chains,
    mutations,
    excluded,
    cycles,
    statementCount: statements.length,
  };
}

function byteWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  return 3;
}

function isForbiddenCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x0b || code === 0x0c || code === 0x85 || code === 0x2028 || code === 0x2029 || code === 0xfeff) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x2060 && code <= 0x2064) return true;
  if (code === 0x00a0 || code === 0x1680 || code === 0x202f || code === 0x205f || code === 0x3000) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  return false;
}

function forbiddenCharacter(line: number, char: string): ProgramDiagnostic {
  const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return diagnostic(line, "program", "invalid-character", `program contains a disallowed character U+${code}`);
}

function precheck(source: string, deadline: Deadline): ProgramDiagnostic | undefined {
  let queries = 0;
  let stringBytes = 0;
  let elements = 0;
  let line = 1;
  const frames: Array<{ kind: "(" | "[" | "{"; expect: boolean }> = [];
  const noteElement = (): ProgramDiagnostic | undefined => {
    const top = frames[frames.length - 1];
    if (!top || top.kind === "(" || !top.expect) return undefined;
    elements += 1;
    top.expect = false;
    if (elements > MAX_LITERAL_ELEMENTS) {
      return diagnostic(line, "program", "literal-budget", `program has more than ${MAX_LITERAL_ELEMENTS} array or object literal elements`);
    }
    return undefined;
  };
  let index = 0;
  while (index < source.length) {
    deadline.tick();
    const char = source[index]!;
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if ((char === "/" && source[index + 1] === "/") || char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        const current = source[index]!;
        if (current === "\\") {
          stringBytes += byteWidth(current);
          index += 1;
          if (index < source.length) stringBytes += byteWidth(source[index]!);
        } else {
          if (current === "\n") line += 1;
          stringBytes += byteWidth(current);
        }
        if (stringBytes > MAX_STRING_LITERAL_BYTES) {
          return diagnostic(line, "program", "string-literal-budget", `program string literals exceed ${MAX_STRING_LITERAL_BYTES} bytes`);
        }
        index += 1;
      }
      index += 1;
      const noted = noteElement();
      if (noted) return noted;
      continue;
    }
    if (isForbiddenCharacter(char)) return forbiddenCharacter(line, char);
    if (char === "(" || char === "[" || char === "{") {
      if (char !== "(") {
        const noted = noteElement();
        if (noted) return noted;
      } else {
        const noted = noteElement();
        if (noted) return noted;
      }
      frames.push({ kind: char, expect: char !== "(" });
      index += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      frames.pop();
      index += 1;
      continue;
    }
    if (char === ",") {
      const top = frames[frames.length - 1];
      if (top && top.kind !== "(") top.expect = true;
      index += 1;
      continue;
    }
    if (char === ":" || char === ".") {
      index += 1;
      continue;
    }
    if (char === "@" || /[A-Za-z_]/.test(char)) {
      let cursor = index;
      if (source[cursor] === "@") cursor += 1;
      const start = cursor;
      if (/[A-Za-z_]/.test(source[cursor] ?? "")) {
        while (/[A-Za-z0-9_]/.test(source[cursor] ?? "")) cursor += 1;
      }
      const name = source.slice(start, cursor);
      if ((index === start || source[index] === "@") && name === "Query") {
        const after = skipSpaceAndComments(source, cursor);
        if (source[after] === "(") {
          queries += 1;
          if (queries > MAX_PROGRAM_QUERIES) {
            return diagnostic(line, "program", "too-many-queries", `program has more than ${MAX_PROGRAM_QUERIES} Query statements`);
          }
        }
      }
      const noted = noteElement();
      if (noted) return noted;
      index = cursor;
      continue;
    }
    const noted = noteElement();
    if (noted) return noted;
    index += 1;
  }
  return undefined;
}

function structuralLimit(source: string, deadline: Deadline): ProgramDiagnostic | undefined {
  if (Buffer.byteLength(source, "utf8") > LIVE_PROGRAM_MAX_BYTES) {
    return diagnostic(1, "program", "program-too-large", `program is larger than ${LIVE_PROGRAM_MAX_BYTES} bytes`);
  }
  const checked = precheck(source, deadline);
  if (checked) return checked;
  let depth = 0;
  let max = 0;
  let inString = false;
  let stringQuote = "";
  let statements = 0;
  let line = 1;
  let atLineStart = true;
  let lineBytes = 0;
  let identLen = 0;
  let inIdent = false;
  let chain = 0;
  let sawDot = false;
  let fieldAccesses = 0;
  let stmtBytes = 0;
  let inStmt = false;
  const finishIdent = (): ProgramDiagnostic | undefined => {
    if (!inIdent) return undefined;
    inIdent = false;
    if (identLen > MAX_IDENTIFIER_CHARS) {
      return diagnostic(line, "program", "identifier-too-long", `identifier is longer than ${MAX_IDENTIFIER_CHARS} characters`);
    }
    identLen = 0;
    if (sawDot) {
      chain += 1;
      sawDot = false;
      if (chain > MAX_CHAIN_SEGMENTS) {
        return diagnostic(line, "program", "chain-too-long", `field access chain is longer than ${MAX_CHAIN_SEGMENTS} segments`);
      }
    } else {
      if (chain > 1) fieldAccesses += chain - 1;
      chain = 1;
    }
    if (fieldAccesses > MAX_FIELD_ACCESSES) {
      return diagnostic(line, "program", "too-many-field-accesses", `program has more than ${MAX_FIELD_ACCESSES} field accesses`);
    }
    return undefined;
  };
  const breakChain = (): ProgramDiagnostic | undefined => {
    if (inIdent) {
      const identError = finishIdent();
      if (identError) return identError;
    }
    if (chain > 1) fieldAccesses += chain - 1;
    chain = 0;
    sawDot = false;
    if (fieldAccesses > MAX_FIELD_ACCESSES) {
      return diagnostic(line, "program", "too-many-field-accesses", `program has more than ${MAX_FIELD_ACCESSES} field accesses`);
    }
    return undefined;
  };
  for (let index = 0; index < source.length; index += 1) {
    deadline.tick();
    const char = source[index]!;
    if (char === "\n") {
      if (lineBytes > MAX_LINE_BYTES) {
        return diagnostic(line, "program", "line-too-long", `line is longer than ${MAX_LINE_BYTES} bytes`);
      }
      const broken = breakChain();
      if (broken) return broken;
      if (inStmt && depth === 0) {
        if (stmtBytes > MAX_STATEMENT_BYTES) {
          return diagnostic(line, "program", "statement-too-large", `statement is larger than ${MAX_STATEMENT_BYTES} bytes`);
        }
        inStmt = false;
        stmtBytes = 0;
      }
      line += 1;
      lineBytes = 0;
      atLineStart = depth === 0;
      continue;
    }
    lineBytes += byteWidth(char);
    if (lineBytes > MAX_LINE_BYTES) {
      return diagnostic(line, "program", "line-too-long", `line is longer than ${MAX_LINE_BYTES} bytes`);
    }
    if (inStmt && depth === 0) stmtBytes += byteWidth(char);
    if (inString) {
      if (char === "\\") {
        index += 1;
        if (index < source.length && source[index] !== "\n") lineBytes += byteWidth(source[index]!);
        continue;
      }
      if (char === stringQuote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      const broken = breakChain();
      if (broken) return broken;
      inString = true;
      stringQuote = char;
      atLineStart = false;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const broken = breakChain();
      if (broken) return broken;
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") {
        index += 1;
        lineBytes += byteWidth(source[index]!);
        if (lineBytes > MAX_LINE_BYTES) {
          return diagnostic(line, "program", "line-too-long", `line is longer than ${MAX_LINE_BYTES} bytes`);
        }
      }
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      const broken = breakChain();
      if (broken) return broken;
      depth += 1;
      if (depth > max) max = depth;
      if (max > MAX_PROGRAM_NESTING) {
        return diagnostic(line, "program", "nesting-limit", `program nests more than ${MAX_PROGRAM_NESTING} levels`);
      }
      atLineStart = false;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const broken = breakChain();
      if (broken) return broken;
      if (depth > 0) depth -= 1;
      atLineStart = false;
      continue;
    }
    if (char === ".") {
      const identError = inIdent ? finishIdent() : undefined;
      if (identError) return identError;
      if (chain > 0) sawDot = true;
      atLineStart = false;
      continue;
    }
    if (/[A-Za-z_]/.test(char) || (inIdent && /[0-9]/.test(char))) {
      if (!inIdent) {
        if (/[0-9]/.test(char)) {
          const broken = breakChain();
          if (broken) return broken;
          atLineStart = false;
          continue;
        }
        inIdent = true;
        identLen = 0;
      }
      identLen += 1;
      if (identLen > MAX_IDENTIFIER_CHARS) {
        return diagnostic(line, "program", "identifier-too-long", `identifier is longer than ${MAX_IDENTIFIER_CHARS} characters`);
      }
      if (atLineStart && depth === 0 && identLen === 1) {
        const match = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(source.slice(index));
        if (match) {
          const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(match[0])?.[0] ?? "";
          if (name.length > MAX_IDENTIFIER_CHARS) {
            return diagnostic(line, "program", "identifier-too-long", `identifier is longer than ${MAX_IDENTIFIER_CHARS} characters`);
          }
          inIdent = false;
          identLen = 0;
          const broken = breakChain();
          if (broken) return broken;
          statements += 1;
          if (statements > MAX_PROGRAM_STATEMENTS) {
            return diagnostic(line, "program", "statement-limit", `program has more than ${MAX_PROGRAM_STATEMENTS} statements`);
          }
          inStmt = true;
          stmtBytes = 0;
          for (let cursor = index + 1; cursor < index + match[0].length; cursor += 1) lineBytes += byteWidth(source[cursor]!);
          if (lineBytes > MAX_LINE_BYTES) {
            return diagnostic(line, "program", "line-too-long", `line is longer than ${MAX_LINE_BYTES} bytes`);
          }
          index += match[0].length - 1;
          atLineStart = false;
          continue;
        }
      }
      atLineStart = false;
      continue;
    }
    if (char === "$" && /[A-Za-z_]/.test(source[index + 1] ?? "")) {
      if (atLineStart && depth === 0) {
        const match = /^\$[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(source.slice(index));
        if (match) {
          const name = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(match[0])?.[1] ?? "";
          if (name.length > MAX_IDENTIFIER_CHARS) {
            return diagnostic(line, "program", "identifier-too-long", `identifier is longer than ${MAX_IDENTIFIER_CHARS} characters`);
          }
          const broken = breakChain();
          if (broken) return broken;
          statements += 1;
          if (statements > MAX_PROGRAM_STATEMENTS) {
            return diagnostic(line, "program", "statement-limit", `program has more than ${MAX_PROGRAM_STATEMENTS} statements`);
          }
          inStmt = true;
          stmtBytes = 0;
          for (let cursor = index + 1; cursor < index + match[0].length; cursor += 1) lineBytes += byteWidth(source[cursor]!);
          if (lineBytes > MAX_LINE_BYTES) {
            return diagnostic(line, "program", "line-too-long", `line is longer than ${MAX_LINE_BYTES} bytes`);
          }
          index += match[0].length - 1;
          atLineStart = false;
          continue;
        }
      }
      const broken = breakChain();
      if (broken) return broken;
      atLineStart = false;
      continue;
    }
    if (char !== " " && char !== "\t" && char !== "\r") {
      const broken = breakChain();
      if (broken) return broken;
      atLineStart = false;
      continue;
    }
  }
  if (inString) return diagnostic(line, "program", "unterminated-string", "unterminated string literal");
  const tail = breakChain();
  if (tail) return tail;
  if (inStmt && stmtBytes > MAX_STATEMENT_BYTES) {
    return diagnostic(line, "program", "statement-too-large", `statement is larger than ${MAX_STATEMENT_BYTES} bytes`);
  }
  return undefined;
}

function extractStatements(source: string, deadline: Deadline): { statements: Statement[]; structural?: ProgramDiagnostic } {
  const statements: Statement[] = [];
  let depth = 0;
  let inString = false;
  let line = 1;
  let index = 0;
  let pendingId = "";
  let pendingLine = 1;
  let bodyStart = -1;
  while (index < source.length) {
    deadline.tick();
    const char = source[index]!;
    if (inString) {
      if (char === "\\") index += 2;
      else {
        if (char === '"') inString = false;
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth -= 1;
      index += 1;
      continue;
    }
    if (char === "\n") {
      if (bodyStart >= 0 && depth === 0) {
        const body = source.slice(bodyStart, index).trim();
        if (Buffer.byteLength(body, "utf8") > MAX_STATEMENT_BYTES) {
          return {
            statements,
            structural: diagnostic(pendingLine, pendingId, "statement-too-large", `statement is larger than ${MAX_STATEMENT_BYTES} bytes`),
          };
        }
        statements.push({ id: pendingId, line: pendingLine, body });
        bodyStart = -1;
      }
      line += 1;
      index += 1;
      continue;
    }
    if (bodyStart < 0 && depth === 0 && /[A-Za-z_$]/.test(char)) {
      let cursor = index;
      if (source[cursor] === "$") cursor += 1;
      if (!/[A-Za-z_]/.test(source[cursor] ?? "")) {
        index += 1;
        continue;
      }
      while (/[A-Za-z0-9_]/.test(source[cursor] ?? "")) cursor += 1;
      let look = cursor;
      while (source[look] === " " || source[look] === "\t") look += 1;
      if (source[look] === "=" && source[look + 1] !== "=") {
        pendingId = source.slice(index, cursor);
        pendingLine = line;
        index = look + 1;
        bodyStart = index;
        continue;
      }
      index = cursor;
      continue;
    }
    index += 1;
  }
  if (bodyStart >= 0) {
    const body = source.slice(bodyStart).trim();
    if (Buffer.byteLength(body, "utf8") > MAX_STATEMENT_BYTES) {
      return {
        statements,
        structural: diagnostic(pendingLine, pendingId, "statement-too-large", `statement is larger than ${MAX_STATEMENT_BYTES} bytes`),
      };
    }
    statements.push({ id: pendingId, line: pendingLine, body });
  }
  return { statements };
}

type Token = { k: "id" | "str" | "num" | "state" | "punct"; v: string };

function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index]!;
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "/" && body[index + 1] === "/") {
      while (index < body.length && body[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < body.length && body[index] !== '"') {
        if (body[index] === "\\") {
          value += body[index + 1] ?? "";
          index += 2;
          continue;
        }
        value += body[index];
        index += 1;
      }
      index += 1;
      tokens.push({ k: "str", v: value });
      continue;
    }
    if (char === "$" && /[A-Za-z_]/.test(body[index + 1] ?? "")) {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index));
      tokens.push({ k: "state", v: match?.[0] ?? "$" });
      index += match?.[0].length ?? 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index));
      tokens.push({ k: "id", v: match?.[0] ?? char });
      index += match?.[0].length ?? 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?/.exec(body.slice(index));
      if (match) {
        tokens.push({ k: "num", v: match[0] });
        index += match[0].length;
        continue;
      }
    }
    if (char === "@") {
      const match = /^@[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index));
      tokens.push({ k: "punct", v: match?.[0] ?? "@" });
      index += match?.[0].length ?? 1;
      continue;
    }
    tokens.push({ k: "punct", v: char });
    index += 1;
  }
  return tokens;
}

function inspectBody(statement: Statement, deadline: Deadline): {
  queries: QueryCall[];
  mutations: Array<{ statementId: string; line: number }>;
  excluded: ProgramDiagnostic[];
  chains: Array<{ statementId: string; line: number; parts: string[] }>;
  fieldAccesses: number;
  structural?: ProgramDiagnostic;
} {
  const tokens = tokenize(statement.body);
  const queries: QueryCall[] = [];
  const mutations: Array<{ statementId: string; line: number }> = [];
  const excluded: ProgramDiagnostic[] = [];
  const chains: Array<{ statementId: string; line: number; parts: string[] }> = [];
  let fieldAccesses = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    deadline.tick();
    const token = tokens[index]!;
    if (token.k === "id" && token.v.length > MAX_IDENTIFIER_CHARS) {
      return {
        queries,
        mutations,
        excluded,
        chains,
        fieldAccesses,
        structural: diagnostic(statement.line, statement.id, "identifier-too-long", `identifier is longer than ${MAX_IDENTIFIER_CHARS} characters`),
      };
    }
    if (token.k === "punct" && (token.v === "@ToAssistant" || token.v === "@OpenUrl")) {
      excluded.push(
        diagnostic(
          statement.line,
          statement.id,
          "excluded-feature",
          `${token.v} is disabled. Button actions are @Set, @Reset, or @Run of a Query.`,
        ),
      );
    }
    if (token.k === "id" && tokens[index + 1]?.v === "." && tokens[index - 1]?.v !== ".") {
      const parts = [token.v];
      let cursor = index + 1;
      while (tokens[cursor]?.v === "." && tokens[cursor + 1]?.k === "id") {
        parts.push(tokens[cursor + 1]!.v);
        cursor += 2;
        if (parts.length > MAX_CHAIN_SEGMENTS) {
          return {
            queries,
            mutations,
            excluded,
            chains,
            fieldAccesses,
            structural: diagnostic(
              statement.line,
              statement.id,
              "chain-too-long",
              `field access chain is longer than ${MAX_CHAIN_SEGMENTS} segments`,
            ),
          };
        }
      }
      fieldAccesses += parts.length - 1;
      if (parts.length > 1) chains.push({ statementId: statement.id, line: statement.line, parts });
      index = cursor - 1;
    }
  }
  return { queries, mutations, excluded, chains, fieldAccesses };
}

function runTargets(body: string): string[] {
  const tokens = tokenize(body);
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.v === "@Run" && tokens[index + 1]?.v === "(" && tokens[index + 2]?.k === "id") {
      targets.push(tokens[index + 2]!.v);
    }
  }
  return targets;
}

function referenceCycle(statements: Statement[], deadline: Deadline): boolean {
  const ids = new Set(statements.map((statement) => statement.id));
  const edges = new Map<string, string[]>();
  for (const statement of statements) {
    deadline.tick();
    const tokens = tokenize(statement.body);
    const refs = new Set<string>();
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      if (previous?.v === "." || next?.v === ":" || next?.v === "(") continue;
      if ((token.k === "id" || token.k === "state") && ids.has(token.v) && token.v !== statement.id) refs.add(token.v);
    }
    edges.set(statement.id, [...refs]);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: Array<{ id: string; index: number }> = [];
  for (const statement of statements) {
    if ((color.get(statement.id) ?? 0) !== 0) continue;
    color.set(statement.id, 1);
    stack.push({ id: statement.id, index: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = edges.get(frame.id) ?? [];
      if (frame.index >= next.length) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const to = next[frame.index]!;
      frame.index += 1;
      const state = color.get(to) ?? 0;
      if (state === 1) return true;
      if (state === 0) {
        color.set(to, 1);
        stack.push({ id: to, index: 0 });
      }
    }
  }
  return false;
}

type Alias = { query: string; path: string[] };

function resolveFields(statements: Statement[], queries: QueryCall[], chains: FieldChain[]): FieldUse[] {
  const queryIds = new Set(queries.map((query) => query.statementId));
  const aliases = new Map<string, Alias>();
  for (const statement of statements) {
    const chain = wholeChain(statement.body);
    if (!chain) continue;
    const resolved = resolveAlias(chain[0]!, aliases, queryIds);
    if (!resolved) continue;
    aliases.set(statement.id, { query: resolved.query, path: [...resolved.path, ...chain.slice(1)] });
  }
  const fields: FieldUse[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    const resolved = resolveAlias(chain.parts[0]!, aliases, queryIds);
    if (!resolved) continue;
    const path = [...resolved.path, ...chain.parts.slice(1)];
    if (path.length === 0) continue;
    const key = `${chain.statementId}:${resolved.query}:${path.join(".")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({
      statementId: chain.statementId,
      line: chain.line,
      query: resolved.query,
      fields: path,
      display: `${resolved.query}.${path.join(".")}`,
    });
  }
  return fields;
}

type FieldChain = { statementId: string; line: number; parts: string[] };

function wholeChain(body: string): string[] | undefined {
  const tokens = tokenize(body);
  if (tokens.length === 0 || tokens[0]?.k !== "id") return undefined;
  const parts = [tokens[0].v];
  let index = 1;
  while (index < tokens.length && tokens[index]?.v === "." && tokens[index + 1]?.k === "id") {
    parts.push(tokens[index + 1]!.v);
    index += 2;
  }
  if (index !== tokens.length) return undefined;
  return parts;
}

function resolveAlias(
  name: string,
  aliases: Map<string, Alias>,
  queryIds: Set<string>,
): { query: string; path: string[] } | undefined {
  const seen = new Set<string>();
  let current = name;
  const prefix: string[] = [];
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    const alias = aliases.get(current)!;
    return { query: alias.query, path: [...alias.path, ...prefix] };
  }
  if (queryIds.has(current)) return { query: current, path: prefix };
  return undefined;
}

function cap(issues: ProgramDiagnostic[]): ProgramDiagnostic[] {
  return [...issues].sort(compareDiagnostics).slice(0, MAX_PROGRAM_ISSUES);
}

function compareDiagnostics(left: ProgramDiagnostic, right: ProgramDiagnostic): number {
  return left.line - right.line || left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message);
}

const TOOL_RULE = "the tool name must be a single string literal that matches a bound function";

type ToolSite = { plain: boolean; value: string };

function skipSpaceAndComments(body: string, index: number): number {
  let cursor = index;
  while (cursor < body.length) {
    const char = body[cursor]!;
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      cursor += 1;
      continue;
    }
    if ((char === "/" && body[cursor + 1] === "/") || char === "#") {
      while (cursor < body.length && body[cursor] !== "\n") cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function endOfString(body: string, index: number): number {
  const quote = body[index]!;
  let cursor = index + 1;
  while (cursor < body.length && body[cursor] !== quote) {
    if (body[cursor] === "\\") cursor += 2;
    else cursor += 1;
  }
  return Math.min(body.length, cursor + 1);
}

function readToolArg(body: string, index: number): ToolSite {
  const cursor = skipSpaceAndComments(body, index);
  const quote = body[cursor];
  if (quote !== '"') return { plain: false, value: "" };
  let value = "";
  let plain = true;
  let next = cursor + 1;
  while (next < body.length && body[next] !== quote) {
    if (body[next] === "\\") {
      plain = false;
      next += 2;
      continue;
    }
    if (body[next] === "\n") return { plain: false, value: "" };
    value += body[next];
    next += 1;
  }
  if (next >= body.length || body[next] !== quote) return { plain: false, value: "" };
  const after = skipSpaceAndComments(body, next + 1);
  if (body[after] !== "," && body[after] !== ")") return { plain: false, value };
  return { plain, value };
}

function querySites(body: string): ToolSite[] {
  const sites: ToolSite[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index]!;
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if ((char === "/" && body[index + 1] === "/") || char === "#") {
      while (index < body.length && body[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = endOfString(body, index);
      continue;
    }
    let cursor = index;
    if (body[cursor] === "@") cursor += 1;
    if (!/[A-Za-z_]/.test(body[cursor] ?? "")) {
      index += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    while (/[A-Za-z0-9_]/.test(body[cursor] ?? "")) cursor += 1;
    const name = body.slice(start, cursor);
    const after = skipSpaceAndComments(body, cursor);
    if (name === "Query" && body[after] === "(") sites.push(readToolArg(body, after + 1));
    index = cursor;
  }
  return sites;
}

function argsFromAst(node: ASTNode | null): Record<string, { literal: boolean; value?: unknown }> {
  if (!node || node.k !== "Obj") return {};
  const args: Record<string, { literal: boolean; value?: unknown }> = {};
  for (const [key, value] of node.entries) {
    if (value.k === "Str") args[key] = { literal: true, value: value.v };
    else if (value.k === "Num") args[key] = { literal: true, value: value.v };
    else if (value.k === "Bool") args[key] = { literal: true, value: value.v };
    else if (value.k === "Null") args[key] = { literal: true, value: null };
    else args[key] = { literal: false };
  }
  return args;
}

function shapeError(line: number, path: string): ProgramDiagnostic {
  return diagnostic(line, path, "unknown-tool", TOOL_RULE);
}

function inlineError(line: number, path: string, name: string): ProgramDiagnostic {
  return diagnostic(line, path, "inline-reserved", `${name}() must be declared as a top-level statement, not used inline as a value`);
}

function mutationError(line: number, path: string): ProgramDiagnostic {
  return diagnostic(line, path, "excluded-feature", "Mutation is disabled. Use Query for read-only data.");
}

function callFromAst(
  statementId: string,
  line: number,
  tool: ASTNode | null,
  args: ASTNode | null,
  site: ToolSite | undefined,
): QueryCall {
  const shapeOk = tool?.k === "Str" && site?.plain === true && site.value === tool.v;
  return {
    statementId,
    line,
    tool: shapeOk && tool?.k === "Str" ? tool.v : undefined,
    shapeOk,
    args: argsFromAst(args),
  };
}

function callMarker(body: string): boolean {
  let index = 0;
  while (index < body.length) {
    const char = body[index]!;
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if ((char === "/" && body[index + 1] === "/") || char === "#") {
      while (index < body.length && body[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = endOfString(body, index);
      continue;
    }
    if (char === "@") return true;
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index));
      const name = match?.[0] ?? "";
      if (name === "Query" || name === "Mutation") return true;
      index += name.length || 1;
      continue;
    }
    index += 1;
  }
  return false;
}

type ExposedCall = {
  kind: "reserved" | "excluded" | "function" | "component";
  name: string;
  inline: boolean;
  tool: ASTNode | null;
  args: ASTNode | null;
};

function exposeCalls(body: string): { expression: unknown; errors: ProgramDiagnostic[] } {
  const direct = parser.parse(`root = ${body}`);
  const parsed = direct.root ? direct : parser.parse(`root = TextContent(${body})`);
  const expression = direct.root
    ? direct.root
    : parsed.root && typeof parsed.root.props?.text === "object"
      ? parsed.root.props.text
      : parsed.root;
  const errors: ProgramDiagnostic[] = [];
  for (const error of parsed.meta.errors) {
    if (error.code !== "unknown-function" && error.code !== "unknown-component") continue;
    errors.push(diagnostic(1, "program", error.code, shorten(error.message)));
  }
  return { expression, errors };
}

function collectCalls(value: unknown): ExposedCall[] {
  const hits: ExposedCall[] = [];
  const visit = (current: unknown, whole: boolean) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, false);
      return;
    }
    const node = current as ASTNode & {
      type?: string;
      typeName?: string;
      props?: Record<string, unknown>;
      mappedProps?: Record<string, ASTNode>;
    };
    if (node.type === "element") {
      if (node.typeName && !VOCABULARY_NAMES.includes(node.typeName) && !ALLOWED_CALLS.has(node.typeName)) {
        hits.push({ kind: "component", name: node.typeName, inline: false, tool: null, args: null });
      }
      for (const prop of Object.values(node.props ?? {})) visit(prop, false);
      return;
    }
    if (!("k" in node)) return;
    if (node.k === "Comp") {
      if (node.name === "Query" || node.name === "Mutation") {
        hits.push({
          kind: "reserved",
          name: node.name,
          inline: !whole,
          tool: node.args[0] ?? null,
          args: node.args[1] ?? null,
        });
        for (const arg of node.args) visit(arg, false);
        return;
      }
      if (node.name === "OpenUrl" || node.name === "ToAssistant") {
        hits.push({ kind: "excluded", name: `@${node.name}`, inline: false, tool: null, args: null });
      } else if (node.mappedProps && !ALLOWED_CALLS.has(node.name)) {
        hits.push({ kind: "function", name: node.name, inline: false, tool: null, args: null });
      } else if (!VOCABULARY_NAMES.includes(node.name) && !ALLOWED_CALLS.has(node.name)) {
        hits.push({ kind: "component", name: node.name, inline: false, tool: null, args: null });
      }
      for (const arg of node.args) visit(arg, false);
      if (node.mappedProps) for (const arg of Object.values(node.mappedProps)) visit(arg, false);
      return;
    }
    if (node.k === "Arr") for (const element of node.els) visit(element, false);
    else if (node.k === "Obj") for (const [, entry] of node.entries) visit(entry, false);
    else if (node.k === "BinOp") {
      visit(node.left, false);
      visit(node.right, false);
    } else if (node.k === "UnaryOp") visit(node.operand, false);
    else if (node.k === "Ternary") {
      visit(node.cond, false);
      visit(node.then, false);
      visit(node.else, false);
    } else if (node.k === "Member") visit(node.obj, false);
    else if (node.k === "Index") {
      visit(node.obj, false);
      visit(node.index, false);
    } else if (node.k === "Assign") visit(node.value, false);
  };
  visit(value, true);
  return hits;
}

function analyzeQueries(scan: Scan, parsed: ParseResult, deadline: Deadline): { queries: QueryCall[]; errors: ProgramDiagnostic[] } {
  const errors: ProgramDiagnostic[] = [];
  const queries: QueryCall[] = [];
  const byId = new Map(scan.statements.map((statement) => [statement.id, statement]));
  const recorded = new Set(parsed.queryStatements.map((query) => query.statementId));
  for (const query of parsed.queryStatements) {
    deadline.tick();
    const statement = byId.get(query.statementId);
    const line = statement?.line ?? 1;
    const sites = statement ? querySites(statement.body) : [];
    if (sites.length !== 1) {
      errors.push(shapeError(line, query.statementId));
      continue;
    }
    const call = callFromAst(query.statementId, line, query.toolAST, query.argsAST, sites[0]);
    if (!call.shapeOk) errors.push(shapeError(line, query.statementId));
    else queries.push(call);
  }
  for (const mutation of parsed.mutationStatements) {
    const statement = byId.get(mutation.statementId);
    errors.push(mutationError(statement?.line ?? 1, mutation.statementId));
  }
  const mutationIds = new Set(parsed.mutationStatements.map((mutation) => mutation.statementId));
  for (const statement of scan.statements) {
    deadline.tick();
    for (const target of runTargets(statement.body)) {
      if (mutationIds.has(target)) {
        errors.push(
          diagnostic(statement.line, statement.id, "excluded-feature", `@Run(${target}) runs a Mutation. Mutations are disabled.`),
        );
      }
    }
    if (recorded.has(statement.id) || !callMarker(statement.body)) continue;
    deadline.force();
    let exposed: { expression: unknown; errors: ProgramDiagnostic[] };
    try {
      exposed = exposeCalls(statement.body);
    } catch (error) {
      if (error instanceof ProgramBudgetExceeded) throw error;
      errors.push(shapeError(statement.line, statement.id));
      continue;
    }
    errors.push(...exposed.errors.map((item) => ({ ...item, line: statement.line, path: statement.id })));
    const hits = collectCalls(exposed.expression);
    for (const hit of hits) {
      if (hit.kind === "excluded") {
        errors.push(
          diagnostic(statement.line, statement.id, "excluded-feature", `${hit.name} is disabled. Button actions are @Set, @Reset, or @Run of a Query.`),
        );
        continue;
      }
      if (hit.kind === "function") {
        errors.push(diagnostic(statement.line, statement.id, "unknown-function", `unknown function @${hit.name}`));
        continue;
      }
      if (hit.kind === "component") {
        errors.push(diagnostic(statement.line, statement.id, "unknown-component", `unknown component ${hit.name}`));
        continue;
      }
      if (hit.name === "Mutation") {
        errors.push(mutationError(statement.line, statement.id));
        if (hit.inline) errors.push(inlineError(statement.line, statement.id, "Mutation"));
        continue;
      }
      if (hit.inline) {
        errors.push(inlineError(statement.line, statement.id, "Query"));
        continue;
      }
      const sites = querySites(statement.body);
      const decided = callFromAst(statement.id, statement.line, hit.tool, hit.args, sites[0]);
      if (!decided.shapeOk || sites.length !== 1) errors.push(shapeError(statement.line, statement.id));
      else queries.push(decided);
    }
  }
  return { queries, errors };
}

function parseChecked(source: string, deadline: Deadline): ParseResult {
  deadline.force();
  try {
    const parsed = parser.parse(source);
    deadline.force();
    return parsed;
  } catch (error) {
    if (error instanceof ProgramBudgetExceeded) throw error;
    throw new Error("parse-failed");
  }
}

function urlLike(text: string): boolean {
  const sample = text.length > 512 ? text.slice(0, 512) : text;
  const lower = sample.toLowerCase();
  return lower.includes("https://") || lower.includes("http://") || lower.includes("javascript:") || lower.includes("data:");
}

function collectUrlWarnings(node: unknown, warnings: ProgramDiagnostic[], depth: number): void {
  if (depth > 40 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectUrlWarnings(item, warnings, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type !== "element" || typeof record.typeName !== "string") return;
  const props = record.props;
  if ((record.typeName === "TextContent" || record.typeName === "Tag") && props && typeof props === "object") {
    const text = (props as Record<string, unknown>).text;
    if (typeof text === "string" && urlLike(text)) {
      warnings.push(
        diagnostic(
          1,
          typeof record.statementId === "string" ? record.statementId : "program",
          "url-like-text",
          "URL-like text: rendered as plain text",
          "warning",
        ),
      );
    }
  }
  if (props && typeof props === "object") {
    for (const value of Object.values(props as Record<string, unknown>)) collectUrlWarnings(value, warnings, depth + 1);
  }
}

function validateProgramAt(source: string, deadline: Deadline): ProgramValidation {
  const scan = scanProgram(source, deadline);
  const errors: ProgramDiagnostic[] = [];
  const warnings: ProgramDiagnostic[] = [];
  if (scan.structural) errors.push(scan.structural);
  if (scan.cycles) {
    errors.push(diagnostic(1, "program", "reference-cycle", "program has a cyclic reference and was rejected"));
  }
  errors.push(...scan.excluded);
  if (scan.structural || scan.cycles) {
    return { ok: false, errors: cap(errors), warnings: [], statementCount: scan.statementCount };
  }
  let parsed: ParseResult;
  try {
    parsed = parseChecked(source, deadline);
  } catch (error) {
    if (error instanceof ProgramBudgetExceeded) throw error;
    errors.push(diagnostic(1, "program", "parse-failed", "program too complex"));
    return { ok: false, errors: cap(errors), warnings: [], statementCount: scan.statementCount };
  }
  const lines = new Map(scan.statements.map((statement) => [statement.id, statement.line]));
  for (const error of parsed.meta.errors) {
    const severity = error.severity === "warning" ? "warning" : "error";
    const path = error.statementId || "program";
    const item = diagnostic(
      error.statementId ? lines.get(error.statementId) ?? 1 : 1,
      path,
      error.code,
      shorten(error.message),
      severity,
    );
    if (severity === "warning") warnings.push(item);
    else errors.push(item);
  }
  if (parsed.meta.incomplete) errors.push(diagnostic(1, "program", "unterminated-string", "unterminated string literal"));
  errors.push(...analyzeQueries(scan, parsed, deadline).errors);
  collectUrlWarnings(parsed.root, warnings, 0);
  if (parsed.root == null && !errors.some((item) => item.code === "no-root") && !warnings.some((item) => item.code === "no-root")) {
    errors.push(diagnostic(1, "program", "no-root", "No root statement, and no statement calls the root component Stack"));
  }
  const cappedErrors = cap(errors);
  return {
    ok: cappedErrors.length === 0,
    errors: cappedErrors,
    warnings: cap(warnings),
    statementCount: parsed.meta.statementCount,
  };
}

export function validateProgram(source: string, options?: ProgramValidationOptions): ProgramValidation {
  try {
    return validateProgramAt(source, createDeadline(options));
  } catch (error) {
    if (error instanceof ProgramBudgetExceeded) {
      return { ok: false, errors: [diagnostic(1, "program", "program-too-complex", "program too complex")], warnings: [], statementCount: 0 };
    }
    throw error;
  }
}

function shorten(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

export type OutputSchema = Record<string, unknown> | undefined;

export type ResolvedOutputSchema = { outputSchema: OutputSchema };

export type FunctionSchemaLoader = (projectRoot: string, functionId: string) => Promise<OutputSchema>;

export function reconcileProgram(
  program: string,
  bindings: readonly Pick<LiveBinding, "id" | "function" | "args">[],
  schemas: ReadonlyMap<string, ResolvedOutputSchema>,
  options?: ProgramValidationOptions,
): { errors: ProgramDiagnostic[]; warnings: ProgramDiagnostic[] } {
  try {
    return reconcileProgramAt(program, bindings, schemas, createDeadline(options));
  } catch (error) {
    if (error instanceof ProgramBudgetExceeded) {
      return { errors: [diagnostic(1, "program", "program-too-complex", "program too complex")], warnings: [] };
    }
    throw error;
  }
}

function outputSchemaFor(schemas: ReadonlyMap<string, ResolvedOutputSchema>, functionId: string): OutputSchema {
  return schemas.get(functionId)?.outputSchema;
}

function reconcileProgramAt(
  program: string,
  bindings: readonly Pick<LiveBinding, "id" | "function" | "args">[],
  schemas: ReadonlyMap<string, ResolvedOutputSchema>,
  deadline: Deadline,
): { errors: ProgramDiagnostic[]; warnings: ProgramDiagnostic[] } {
  const scan = scanProgram(program, deadline);
  const errors: ProgramDiagnostic[] = [];
  const warnings: ProgramDiagnostic[] = [];
  if (scan.structural) errors.push(scan.structural);
  if (scan.cycles) {
    errors.push(diagnostic(1, "program", "reference-cycle", "program has a cyclic reference and was rejected"));
  }
  if (errors.length > 0) return { errors: cap(errors), warnings: [] };
  let parsed: ParseResult;
  try {
    parsed = parseChecked(program, deadline);
  } catch (error) {
    if (error instanceof ProgramBudgetExceeded) throw error;
    return { errors: cap([diagnostic(1, "program", "parse-failed", "program too complex")]), warnings: [] };
  }
  const analysis = analyzeQueries(scan, parsed, deadline);
  errors.push(...analysis.errors);
  const queries = analysis.queries;
  const fields = resolveFields(scan.statements, queries, scan.chains);
  const declared = [...new Set(bindings.map((binding) => binding.function))].sort();
  const used = new Set<string>();
  const schemaWarned = new Set<string>();
  for (const query of queries) {
    if (!query.shapeOk || !query.tool) {
      errors.push(shapeError(query.line, query.statementId));
      continue;
    }
    const matches = bindings.filter((binding) => binding.function === query.tool);
    if (matches.length === 0) {
      const list = declared.length > 0 ? declared.join(", ") : "(none)";
      errors.push(
        diagnostic(
          query.line,
          query.statementId,
          "unknown-tool",
          `Query tool "${query.tool}" is not a binding function. Declared functions: ${list}.`,
        ),
      );
      continue;
    }
    used.add(query.tool);
    const argWarning = argumentWarning(query, matches);
    if (argWarning) warnings.push(argWarning);
    const schema = outputSchemaFor(schemas, query.tool);
    if (schema === undefined) {
      if (!schemaWarned.has(query.tool)) {
        schemaWarned.add(query.tool);
        warnings.push(
          diagnostic(
            query.line,
            query.statementId,
            "output-schema-missing",
            `output schema not declared for ${query.tool}`,
            "warning",
          ),
        );
      }
    }
  }
  for (const field of fields) {
    const query = queries.find((item) => item.statementId === field.query);
    if (!query?.tool) continue;
    if (!bindings.some((binding) => binding.function === query.tool)) continue;
    const schema = outputSchemaFor(schemas, query.tool);
    if (schema === undefined) continue;
    const checked = schemaPath(schema, field.fields);
    if (!checked.ok) {
      const names = checked.valid.length > 0 ? checked.valid.join(", ") : "(none)";
      errors.push(
        diagnostic(
          field.line,
          field.statementId,
          "unknown-field",
          `${field.display} is not in the output schema of ${query.tool}. Fields: ${names}.`,
        ),
      );
    }
  }
  for (const binding of bindings) {
    if (used.has(binding.function)) continue;
    warnings.push(
      diagnostic(
        1,
        `bindings.${binding.id}`,
        "binding-unused",
        `binding ${binding.id} (${binding.function}) is not queried by the program`,
        "warning",
      ),
    );
  }
  return { errors: cap(errors), warnings: cap(warnings) };
}

function argumentWarning(query: QueryCall, matches: readonly Pick<LiveBinding, "id" | "args">[]): ProgramDiagnostic | undefined {
  const matched = matches.some((binding) => argsCompatible(query.args, binding.args));
  if (matched) return undefined;
  const programKeys = Object.keys(query.args).sort().join(", ") || "(none)";
  const bindingKeys = [...new Set(matches.flatMap((binding) => Object.keys(binding.args)))].sort().join(", ") || "(none)";
  return diagnostic(
    query.line,
    query.statementId,
    "binding-args",
    `Query ${query.tool} arguments do not match binding ${matches.map((binding) => binding.id).join(", ")}. Program keys: ${programKeys}. Binding keys: ${bindingKeys}. A literal mismatch is a warning.`,
    "warning",
  );
}

function argsCompatible(
  programArgs: Record<string, { literal: boolean; value?: unknown }>,
  bindingArgs: Record<string, unknown>,
): boolean {
  const programKeys = Object.keys(programArgs).sort();
  const bindingKeys = Object.keys(bindingArgs).sort();
  if (programKeys.join("\0") !== bindingKeys.join("\0")) return false;
  for (const key of programKeys) {
    const arg = programArgs[key]!;
    if (!arg.literal) continue;
    if (!sameLiteral(arg.value, bindingArgs[key])) return false;
  }
  return true;
}

function sameLiteral(left: unknown, right: unknown): boolean {
  return left === right;
}

function schemaPath(schema: Record<string, unknown>, fields: string[]): { ok: true } | { ok: false; valid: string[] } {
  let node: unknown = schema;
  for (let index = 0; index < fields.length; index += 1) {
    node = unwrapSchema(node);
    const record = asRecord(node);
    if (record?.type === "array") {
      node = unwrapSchema(record.items);
    }
    const current = asRecord(node);
    const properties = asRecord(current?.properties);
    const field = fields[index]!;
    if (!properties || !Object.prototype.hasOwnProperty.call(properties, field)) {
      return { ok: false, valid: properties ? Object.keys(properties).sort() : [] };
    }
    node = properties[field];
  }
  return { ok: true };
}

function unwrapSchema(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (Array.isArray(record.anyOf) && record.anyOf.length > 0) return unwrapSchema(record.anyOf[0]);
  if (Array.isArray(record.oneOf) && record.oneOf.length > 0) return unwrapSchema(record.oneOf[0]);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function toIssues(items: ProgramDiagnostic[]): ArtifactIssue[] {
  return items.map((item) => ({ path: item.path, code: item.code, message: item.message }));
}

let activeValidations = 0;
const validationWaiters: Array<() => void> = [];

async function withProgramValidation<T>(run: () => Promise<T>): Promise<T> {
  if (activeValidations >= MAX_CONCURRENT_PROGRAM_VALIDATIONS) {
    if (validationWaiters.length >= MAX_QUEUED_PROGRAM_VALIDATIONS) {
      throw new ArtifactPublishError(429, "artifact.resource_limit", "Too many program validations are waiting");
    }
    await new Promise<void>((resolve) => {
      validationWaiters.push(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } else {
    activeValidations += 1;
  }
  try {
    return await run();
  } finally {
    const next = validationWaiters.shift();
    if (next) next();
    else activeValidations -= 1;
  }
}

export async function loadFunctionOutputSchema(projectRoot: string, functionId: string): Promise<OutputSchema> {
  const loaded = await readFunctionFile(projectRoot, functionId);
  if (loaded.missing || !loaded.parsed.ok || loaded.parsed.value.id !== functionId) return undefined;
  return loaded.parsed.value.output_schema;
}

async function loadSchemas(
  projectRoot: string,
  functionIds: readonly string[],
  load: FunctionSchemaLoader,
): Promise<Map<string, ResolvedOutputSchema>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const loaded = await Promise.all(
          functionIds.map(async (functionId) => [functionId, { outputSchema: await load(projectRoot, functionId) }] as const),
        );
        return new Map(loaded);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("function-load-timeout")), FUNCTION_LOAD_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function assertLiveProgramAtPublish(
  projectRoot: string,
  manifest: LiveManifest,
  load: FunctionSchemaLoader = loadFunctionOutputSchema,
): Promise<ArtifactIssue[]> {
  return withProgramValidation(() => assertLiveProgram(projectRoot, manifest, load));
}

async function assertLiveProgram(
  projectRoot: string,
  manifest: LiveManifest,
  load: FunctionSchemaLoader,
): Promise<ArtifactIssue[]> {
  if (manifest.format !== OPENUI_LANG_FORMAT) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", `unsupported format: ${manifest.format}`, [
      { path: "manifest.format", code: "unsupported-format", message: "unsupported format" },
    ]);
  }
  if (manifest.library.name !== LIBRARY_NAME) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", `library.name must be ${LIBRARY_NAME}`, [
      { path: "manifest.library.name", code: "library-name", message: `library.name must be ${LIBRARY_NAME}` },
    ]);
  }
  if (libraryVersionStatus(manifest) !== "current") {
    throw new ArtifactPublishError(
      400,
      "artifact.invalid_shape",
      `library.version must be ${LIBRARY_VERSION}`,
      [
        {
          path: "manifest.library.version",
          code: "library-version",
          message: `library.version must be ${LIBRARY_VERSION}. A stored artifact renders with the library version that wrote it.`,
        },
      ],
    );
  }
  const validated = validateProgram(manifest.program);
  if (!validated.ok) {
    throw new ArtifactPublishError(
      400,
      "artifact.program_invalid",
      validated.errors[0]?.message ?? "program is not valid",
      toIssues(validated.errors),
    );
  }
  const functionIds = [...new Set(manifest.bindings.map((binding) => binding.function))];
  let schemas: Map<string, ResolvedOutputSchema>;
  try {
    schemas = await loadSchemas(projectRoot, functionIds, load);
  } catch (error) {
    if (error instanceof ArtifactPublishError) throw error;
    throw new ArtifactPublishError(400, "artifact.program_invalid", "program too complex", [
      { path: "program", code: "program-too-complex", message: "program too complex" },
    ]);
  }
  const reconciled = reconcileProgram(manifest.program, manifest.bindings, schemas);
  if (reconciled.errors.length > 0) {
    throw new ArtifactPublishError(
      400,
      "artifact.program_invalid",
      reconciled.errors[0]?.message ?? "program is not valid",
      toIssues(reconciled.errors),
    );
  }
  return toIssues([...validated.warnings, ...reconciled.warnings].sort(compareDiagnostics).slice(0, MAX_PROGRAM_ISSUES));
}

export function lineOf(source: string, index: number): number {
  return lineAt(source, index);
}
