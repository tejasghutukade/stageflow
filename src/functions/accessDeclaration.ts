export type AccessLevel = "none" | "read" | "write";
export type FunctionAccessKind = "verification" | "routing" | "tool";

export type FunctionAccessFile = {
  root: "artifacts" | "workspace";
  path: string;
  access: "read" | "write";
};

export type FunctionAccessEnv = {
  name: string;
  optional: boolean;
};

export type FunctionAccessNetwork = {
  origin: string;
  effect: "read" | "action";
  methods: string[];
  path: string;
  credential?: string;
};

export type FunctionAccessDeclaration = {
  artifacts: AccessLevel;
  workspace: AccessLevel;
  files: FunctionAccessFile[];
  env: FunctionAccessEnv[];
  network: FunctionAccessNetwork[];
};

export type AccessPos = { line: number; column: number };

export type AccessIssue = { message: string; line: number; column: number };

export type AccessLocations = {
  statement: AccessPos;
  artifacts?: AccessPos;
  workspace?: AccessPos;
  files: AccessPos[];
  env: AccessPos[];
  network: AccessPos[];
};

export type AccessRead =
  | { present: false }
  | {
      present: true;
      ok: true;
      access: FunctionAccessDeclaration;
      range: { start: number; end: number };
      locations: AccessLocations;
    }
  | { present: true; ok: false; issues: AccessIssue[] };

const SOURCE_LIMIT = 64 * 1024;
const ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const READ_METHODS = ["GET"];
const ACTION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const FIRST_STATEMENT = "access must be the first statement in the file";

type PosState = { i: number; line: number; column: number };

type ExportHit = { index: number; line: number; column: number; kind: "const" | "let" | "var" };

type Node =
  | { type: "string"; value: string; pos: AccessPos }
  | { type: "number"; value: number; pos: AccessPos }
  | { type: "boolean"; value: boolean; pos: AccessPos }
  | { type: "null"; pos: AccessPos }
  | { type: "array"; items: Node[]; pos: AccessPos }
  | { type: "object"; props: Array<{ key: string; keyPos: AccessPos; value: Node }>; pos: AccessPos };

class AccessParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AccessParseError";
    this.line = line;
    this.column = column;
  }
}

export function readAccessDeclaration(source: string): AccessRead {
  const bounded = source.length > SOURCE_LIMIT ? source.slice(0, SOURCE_LIMIT) : source;
  const found = scanAccessExports(bounded);
  const head = skipTrivia(bounded, { i: 0, line: 1, column: 1 });
  const atHead = found.find((hit) => hit.index === head.i);
  if (atHead?.kind === "const") {
    const parsed = parseDeclaration(bounded, atHead);
    const extras = found.filter((hit) => hit.index !== atHead.index);
    if (!(parsed.present && parsed.ok)) {
      return {
        present: true,
        ok: false,
        issues: [...(parsed.present ? parsed.issues : []), ...extras.map(firstStatementIssue)],
      };
    }
    if (extras.length > 0) {
      return { present: true, ok: false, issues: extras.map(firstStatementIssue) };
    }
    return parsed;
  }
  if (found.length > 0) {
    return { present: true, ok: false, issues: found.map(firstStatementIssue) };
  }
  return { present: false };
}

export function deriveAccess(
  access: FunctionAccessDeclaration,
  kind: FunctionAccessKind,
): { capabilities: unknown[]; bindings: unknown[] } {
  const checked = kind === "tool" || kind === "verification" || kind === "routing";
  void checked;
  const taken = new Set<string>();
  const capabilities: unknown[] = [];
  const bindings: unknown[] = [];
  if (access.artifacts !== "none") {
    capabilities.push({
      id: uniqueId("artifacts", taken),
      type: "file",
      root: "artifacts",
      path: "",
      access: access.artifacts,
    });
  }
  if (access.workspace !== "none") {
    capabilities.push({
      id: uniqueId("workspace", taken),
      type: "file",
      root: "workspace",
      path: "",
      access: access.workspace,
    });
  }
  for (const file of access.files) {
    capabilities.push({
      id: uniqueId(fileCapabilityId(file.root, file.path), taken),
      type: "file",
      root: file.root,
      path: file.path,
      access: file.access,
    });
  }
  for (const env of access.env) {
    capabilities.push({
      id: uniqueId(`env_${env.name.toLowerCase()}`, taken),
      type: "env",
      alias: env.name,
    });
    bindings.push({ alias: env.name, required: env.optional !== true });
  }
  for (const entry of access.network) {
    const capability: Record<string, unknown> = {
      id: uniqueId(networkCapabilityId(entry.origin), taken),
      type: "api",
      origin: entry.origin,
      methods: [...entry.methods],
      path_prefix: entry.path,
      effect: entry.effect,
    };
    if (entry.credential !== undefined) capability.credential_ref = entry.credential;
    capabilities.push(capability);
  }
  return { capabilities, bindings };
}

export function accessFromCapabilities(
  capabilities: readonly unknown[],
  bindings: readonly unknown[],
): FunctionAccessDeclaration {
  const access = emptyAccess();
  let artifactsSet = false;
  let workspaceSet = false;
  const required = new Map<string, boolean>();
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.alias !== "string") continue;
    required.set(binding.alias, binding.required !== false);
  }
  for (const raw of capabilities) {
    if (!isRecord(raw)) continue;
    if (raw.type === "file" && (raw.root === "artifacts" || raw.root === "workspace") && (raw.access === "read" || raw.access === "write")) {
      const filePath = typeof raw.path === "string" ? raw.path : "";
      const whole = filePath === "" || filePath === ".";
      if (whole && raw.root === "artifacts" && !artifactsSet) {
        access.artifacts = raw.access;
        artifactsSet = true;
        continue;
      }
      if (whole && raw.root === "workspace" && !workspaceSet) {
        access.workspace = raw.access;
        workspaceSet = true;
        continue;
      }
      access.files.push({ root: raw.root, path: filePath === "." ? "" : filePath, access: raw.access });
      continue;
    }
    if (raw.type === "env" && typeof raw.alias === "string") {
      access.env.push({ name: raw.alias, optional: required.get(raw.alias) === false });
      continue;
    }
    if (
      raw.type === "api" &&
      typeof raw.origin === "string" &&
      (raw.effect === "read" || raw.effect === "action") &&
      Array.isArray(raw.methods) &&
      raw.methods.every((method) => typeof method === "string") &&
      typeof raw.path_prefix === "string"
    ) {
      const entry: FunctionAccessNetwork = {
        origin: raw.origin,
        effect: raw.effect,
        methods: [...raw.methods],
        path: raw.path_prefix,
      };
      if (typeof raw.credential_ref === "string") entry.credential = raw.credential_ref;
      access.network.push(entry);
    }
  }
  return access;
}

export function formatAccessDeclaration(access: FunctionAccessDeclaration): string {
  const lines = ["export const access = {", `  artifacts: ${quote(access.artifacts)},`];
  if (access.workspace !== "none") lines.push(`  workspace: ${quote(access.workspace)},`);
  if (access.files.length > 0) {
    lines.push("  files: [");
    for (const file of access.files) {
      lines.push(`    { root: ${quote(file.root)}, path: ${quote(file.path)}, access: ${quote(file.access)} },`);
    }
    lines.push("  ],");
  }
  lines.push(`  env: ${formatEnv(access.env)},`);
  lines.push(`  network: ${formatNetwork(access.network)},`);
  lines.push("};");
  return lines.join("\n");
}

export function writeAccessDeclaration(source: string, access: FunctionAccessDeclaration): string {
  const text = formatAccessDeclaration(access);
  const read = readAccessDeclaration(source);
  if (read.present && read.ok) return source.slice(0, read.range.start) + text + source.slice(read.range.end);
  if (read.present) return source;
  return `${text}\n\n${source}`;
}

export function describeDeclaration(access: FunctionAccessDeclaration): string[] {
  const labels: string[] = [];
  if (access.artifacts === "read") labels.push("Read artifacts");
  if (access.artifacts === "write") labels.push("Read and write artifacts");
  if (access.workspace === "read") labels.push("Read workspace");
  if (access.workspace === "write") labels.push("Read and write workspace");
  for (const file of access.files) {
    const verb = file.access === "write" ? "Write" : "Read";
    labels.push(`${verb} ${file.root} ${file.path}`);
  }
  for (const env of access.env) labels.push(env.optional ? `Env ${env.name} (optional)` : `Env ${env.name}`);
  for (const entry of access.network) labels.push(`API ${entry.origin} (${entry.effect})`);
  return labels;
}

export function accessCapabilityAnchors(access: FunctionAccessDeclaration, locations: AccessLocations): AccessPos[] {
  const spans: AccessPos[] = [];
  if (access.artifacts !== "none") spans.push(locations.artifacts ?? locations.statement);
  if (access.workspace !== "none") spans.push(locations.workspace ?? locations.statement);
  spans.push(...locations.files, ...locations.env, ...locations.network);
  return spans;
}

function emptyAccess(): FunctionAccessDeclaration {
  return { artifacts: "none", workspace: "none", files: [], env: [], network: [] };
}

function firstStatementIssue(hit: ExportHit): AccessIssue {
  return { message: FIRST_STATEMENT, line: hit.line, column: hit.column };
}

function parseDeclaration(source: string, hit: ExportHit): AccessRead {
  const parser = new LiteralParser(source, hit.index, hit.line, hit.column);
  try {
    const start = parser.index;
    const statement = parser.position();
    parser.expectKeyword("export");
    parser.skipTrivia();
    parser.expectKeyword("const");
    parser.skipTrivia();
    parser.expectKeyword("access");
    parser.skipTrivia();
    parser.expectChar("=");
    parser.skipTrivia();
    const value = parser.parseValue();
    parser.skipTrivia();
    parser.expectChar(";");
    const access = normalizeAccess(value, statement);
    return {
      present: true,
      ok: true,
      access: access.access,
      range: { start, end: parser.index },
      locations: access.locations,
    };
  } catch (error) {
    if (error instanceof AccessParseError) {
      return { present: true, ok: false, issues: [{ message: error.message, line: error.line, column: error.column }] };
    }
    throw error;
  }
}

function normalizeAccess(node: Node, statement: AccessPos): { access: FunctionAccessDeclaration; locations: AccessLocations } {
  if (node.type !== "object") fail(node.pos, "access must be an object literal");
  const access = emptyAccess();
  const locations: AccessLocations = { statement, files: [], env: [], network: [] };
  for (const prop of node.props) {
    if (prop.key === "artifacts" || prop.key === "workspace") {
      access[prop.key] = readLevel(prop.value, prop.key);
      locations[prop.key] = prop.keyPos;
      continue;
    }
    if (prop.key === "files") {
      access.files = readFiles(prop.value, locations);
      continue;
    }
    if (prop.key === "env") {
      access.env = readEnv(prop.value, locations);
      continue;
    }
    if (prop.key === "network") {
      access.network = readNetwork(prop.value, locations);
      continue;
    }
    fail(prop.keyPos, `unknown access key "${prop.key}"`);
  }
  return { access, locations };
}

function readLevel(node: Node, key: string): AccessLevel {
  if (node.type !== "string") fail(node.pos, `${key} must be a string`);
  if (node.value === "none" || node.value === "read" || node.value === "write") return node.value;
  fail(node.pos, `${key} must be "none", "read", or "write"`);
}

function readFiles(node: Node, locations: AccessLocations): FunctionAccessFile[] {
  if (node.type !== "array") fail(node.pos, "files must be an array");
  return node.items.map((item) => {
    if (item.type !== "object") fail(item.pos, "a files entry must be an object");
    locations.files.push(item.pos);
    const root = requiredKey(item, "root");
    const filePath = requiredKey(item, "path");
    const access = requiredKey(item, "access");
    rejectUnknown(item, ["root", "path", "access"]);
    if (root.type !== "string") fail(root.pos, "root must be a string");
    if (root.value !== "artifacts" && root.value !== "workspace") fail(root.pos, 'root must be "artifacts" or "workspace"');
    if (filePath.type !== "string") fail(filePath.pos, "path must be a string");
    if (access.type !== "string") fail(access.pos, "access must be a string");
    if (access.value !== "read" && access.value !== "write") fail(access.pos, 'access must be "read" or "write"');
    return { root: root.value, path: filePath.value, access: access.value };
  });
}

function readEnv(node: Node, locations: AccessLocations): FunctionAccessEnv[] {
  if (node.type !== "array") fail(node.pos, "env must be an array");
  return node.items.map((item) => {
    locations.env.push(item.pos);
    if (item.type !== "string") fail(item.pos, "an env name must be a string");
    if (item.value.endsWith("?")) return { name: item.value.slice(0, -1), optional: true };
    return { name: item.value, optional: false };
  });
}

function readNetwork(node: Node, locations: AccessLocations): FunctionAccessNetwork[] {
  if (node.type !== "array") fail(node.pos, "network must be an array");
  return node.items.map((item) => {
    locations.network.push(item.pos);
    if (item.type === "string") {
      return { origin: item.value, effect: "read", methods: [...READ_METHODS], path: "/" };
    }
    if (item.type !== "object") fail(item.pos, "a network entry must be a string or an object");
    rejectUnknown(item, ["origin", "effect", "methods", "path", "credential"]);
    const origin = requiredKey(item, "origin");
    if (origin.type !== "string") fail(origin.pos, "origin must be a string");
    const effectNode = optionalKey(item, "effect");
    let effect: "read" | "action" = "read";
    if (effectNode) {
      if (effectNode.type !== "string") fail(effectNode.pos, "effect must be a string");
      if (effectNode.value !== "read" && effectNode.value !== "action") {
        fail(effectNode.pos, 'effect must be "read" or "action"');
      }
      effect = effectNode.value;
    }
    const methodsNode = optionalKey(item, "methods");
    let methods = effect === "action" ? [...ACTION_METHODS] : [...READ_METHODS];
    if (methodsNode) {
      if (methodsNode.type !== "array") fail(methodsNode.pos, "methods must be an array of strings");
      methods = methodsNode.items.map((method) => {
        if (method.type !== "string") fail(method.pos, "a method must be a string");
        return method.value;
      });
    }
    const pathNode = optionalKey(item, "path");
    let path = "/";
    if (pathNode) {
      if (pathNode.type !== "string") fail(pathNode.pos, "path must be a string");
      path = pathNode.value;
    }
    const credentialNode = optionalKey(item, "credential");
    let credential: string | undefined;
    if (credentialNode) {
      if (credentialNode.type !== "string") fail(credentialNode.pos, "credential must be a string");
      credential = credentialNode.value;
    }
    return {
      origin: origin.value,
      effect,
      methods,
      path,
      ...(credential !== undefined ? { credential } : {}),
    };
  });
}

function requiredKey(node: Extract<Node, { type: "object" }>, key: string): Node {
  const found = node.props.find((prop) => prop.key === key);
  if (!found) fail(node.pos, `missing ${key}`);
  return found.value;
}

function optionalKey(node: Extract<Node, { type: "object" }>, key: string): Node | undefined {
  return node.props.find((prop) => prop.key === key)?.value;
}

function rejectUnknown(node: Extract<Node, { type: "object" }>, allowed: readonly string[]): void {
  for (const prop of node.props) {
    if (!allowed.includes(prop.key)) fail(prop.keyPos, `unknown access key "${prop.key}"`);
  }
}

function fail(pos: AccessPos, message: string): never {
  throw new AccessParseError(message, pos.line, pos.column);
}

class LiteralParser {
  constructor(
    private readonly source: string,
    public index: number,
    private line: number,
    private column: number,
  ) {}

  position(): AccessPos {
    return { line: this.line, column: this.column };
  }

  parseValue(): Node {
    this.skipTrivia();
    const pos = this.position();
    const ch = this.char();
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"' || ch === "'") return { type: "string", value: this.parseString(ch), pos };
    if (ch === "`") this.fail("template literals are not allowed in an access declaration");
    if (ch === "." && this.source[this.index + 1] === ".") this.fail("spread is not allowed in an access declaration");
    if (ch === "(") this.fail("calls are not allowed in an access declaration");
    if (ch === "+" || ch === "*" || ch === "/" || ch === "%") this.fail("arithmetic is not allowed in an access declaration");
    if (ch === "-" || isDigit(ch)) return { type: "number", value: this.parseNumber(), pos };
    if (isIdentStart(ch)) {
      const word = this.readIdent();
      this.skipTrivia();
      if (this.char() === "(") this.failAt(pos, "calls are not allowed in an access declaration");
      if (word === "true") return { type: "boolean", value: true, pos };
      if (word === "false") return { type: "boolean", value: false, pos };
      if (word === "null") return { type: "null", pos };
      this.failAt(pos, "only literals are allowed in an access declaration");
    }
    this.fail(ch === "" ? "access declaration ended early" : `unexpected '${ch}'`);
  }

  expectKeyword(word: string): void {
    const pos = this.position();
    if (this.readIdent() !== word) throw new AccessParseError(`expected ${word}`, pos.line, pos.column);
  }

  expectChar(ch: string): void {
    const pos = this.position();
    if (this.char() !== ch) throw new AccessParseError(`expected '${ch}'`, pos.line, pos.column);
    this.bump();
  }

  skipTrivia(): void {
    const next = skipTrivia(this.source, { i: this.index, line: this.line, column: this.column });
    this.index = next.i;
    this.line = next.line;
    this.column = next.column;
  }

  private parseObject(): Node {
    const pos = this.position();
    this.expectChar("{");
    const props: Array<{ key: string; keyPos: AccessPos; value: Node }> = [];
    const seen = new Set<string>();
    this.skipTrivia();
    while (this.char() !== "}" && this.char() !== "") {
      if (this.char() === "." && this.source[this.index + 1] === ".") {
        this.fail("spread is not allowed in an access declaration");
      }
      if (this.char() === "[") this.fail("computed keys are not allowed in an access declaration");
      const keyPos = this.position();
      const key = this.parseKey();
      if (seen.has(key)) throw new AccessParseError(`duplicate access key "${key}"`, keyPos.line, keyPos.column);
      seen.add(key);
      this.skipTrivia();
      if ((key === "get" || key === "set") && isIdentStart(this.char())) {
        this.fail("getters are not allowed in an access declaration");
      }
      if (this.char() === "(") this.fail("functions are not allowed in an access declaration");
      this.expectChar(":");
      this.skipTrivia();
      props.push({ key, keyPos, value: this.parseValue() });
      this.skipTrivia();
      if (this.char() === ",") {
        this.bump();
        this.skipTrivia();
        continue;
      }
      break;
    }
    this.expectChar("}");
    return { type: "object", props, pos };
  }

  private parseArray(): Node {
    const pos = this.position();
    this.expectChar("[");
    const items: Node[] = [];
    this.skipTrivia();
    while (this.char() !== "]" && this.char() !== "") {
      if (this.char() === "." && this.source[this.index + 1] === ".") {
        this.fail("spread is not allowed in an access declaration");
      }
      items.push(this.parseValue());
      this.skipTrivia();
      if (this.char() === ",") {
        this.bump();
        this.skipTrivia();
        continue;
      }
      break;
    }
    this.expectChar("]");
    return { type: "array", items, pos };
  }

  private parseKey(): string {
    const ch = this.char();
    if (ch === '"' || ch === "'") return this.parseString(ch);
    if (!isIdentStart(ch)) this.fail("expected a key");
    return this.readIdent();
  }

  private parseString(quoteChar: string): string {
    this.bump();
    let value = "";
    while (this.char() !== quoteChar) {
      const ch = this.char();
      if (ch === "" || ch === "\n" || ch === "\r") this.fail("unterminated string");
      if (ch !== "\\") {
        value += ch;
        this.bump();
        continue;
      }
      const pos = this.position();
      this.bump();
      const escaped = this.char();
      if (escaped === "" || escaped === "\n" || escaped === "\r") this.fail("unterminated string");
      this.bump();
      if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "b") value += "\b";
      else if (escaped === "f") value += "\f";
      else if (escaped === "\\" || escaped === "'" || escaped === '"' || escaped === "/") value += escaped;
      else if (escaped === "u") {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new AccessParseError("invalid string escape", pos.line, pos.column);
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.bump(4);
      } else if (escaped === "x") {
        const hex = this.source.slice(this.index, this.index + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new AccessParseError("invalid string escape", pos.line, pos.column);
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.bump(2);
      } else {
        throw new AccessParseError("invalid string escape", pos.line, pos.column);
      }
    }
    this.bump();
    return value;
  }

  private parseNumber(): number {
    const pos = this.position();
    const start = this.index;
    if (this.char() === "-") this.bump();
    if (this.char() === "0" && isDigit(this.source[this.index + 1] ?? "")) {
      this.failAt(pos, "invalid number");
    }
    if (!isDigit(this.char())) this.failAt(pos, "invalid number");
    while (isDigit(this.char())) this.bump();
    if (this.char() === ".") {
      this.bump();
      if (!isDigit(this.char())) this.failAt(pos, "invalid number");
      while (isDigit(this.char())) this.bump();
    }
    if (this.char() === "e" || this.char() === "E") {
      this.bump();
      if (this.char() === "+" || this.char() === "-") this.bump();
      if (!isDigit(this.char())) this.failAt(pos, "invalid number");
      while (isDigit(this.char())) this.bump();
    }
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) this.failAt(pos, "invalid number");
    return value;
  }

  private readIdent(): string {
    if (!isIdentStart(this.char())) this.fail("expected an identifier");
    const start = this.index;
    this.bump();
    while (isIdentPart(this.char())) this.bump();
    return this.source.slice(start, this.index);
  }

  private char(): string {
    return this.source[this.index] ?? "";
  }

  private bump(count = 1): void {
    for (let n = 0; n < count; n += 1) {
      const ch = this.source[this.index];
      if (ch === undefined) return;
      this.index += 1;
      if (ch === "\n") {
        this.line += 1;
        this.column = 1;
      } else if (ch === "\r") {
        this.line += 1;
        this.column = 1;
        if (this.source[this.index] === "\n") this.index += 1;
      } else {
        this.column += 1;
      }
    }
  }

  private fail(message: string): never {
    throw new AccessParseError(message, this.line, this.column);
  }

  private failAt(pos: AccessPos, message: string): never {
    throw new AccessParseError(message, pos.line, pos.column);
  }
}

function scanAccessExports(source: string): ExportHit[] {
  const hits: ExportHit[] = [];
  const state: PosState = { i: 0, line: 1, column: 1 };
  const stack: Array<{ kind: "code"; braces: number } | { kind: "template" }> = [{ kind: "code", braces: 0 }];
  let guard = 0;
  while (state.i < source.length) {
    if (guard > source.length + 8) break;
    guard += 1;
    const before = state.i;
    const frame = stack[stack.length - 1] ?? { kind: "code" as const, braces: 0 };
    const ch = source[state.i] ?? "";
    const next = source[state.i + 1];
    if (frame.kind === "template") {
      if (ch === "\\") {
        bumpState(source, state, 1);
        if (state.i < source.length) bumpState(source, state, 1);
      } else if (ch === "`") {
        stack.pop();
        bumpState(source, state, 1);
      } else if (ch === "$" && next === "{") {
        stack.push({ kind: "code", braces: 0 });
        bumpState(source, state, 2);
      } else {
        bumpState(source, state, 1);
      }
    } else if (ch === "/" && next === "/") {
      bumpState(source, state, 2);
      while (state.i < source.length && source[state.i] !== "\n" && source[state.i] !== "\r") bumpState(source, state, 1);
    } else if (ch === "/" && next === "*") {
      bumpState(source, state, 2);
      while (state.i < source.length && !(source[state.i] === "*" && source[state.i + 1] === "/")) bumpState(source, state, 1);
      if (state.i < source.length) bumpState(source, state, 2);
    } else if (ch === "'" || ch === '"') {
      const quoteChar = ch;
      bumpState(source, state, 1);
      while (state.i < source.length && source[state.i] !== quoteChar) {
        if (source[state.i] === "\\") bumpState(source, state, 1);
        if (state.i < source.length) bumpState(source, state, 1);
      }
      if (state.i < source.length) bumpState(source, state, 1);
    } else if (ch === "`") {
      stack.push({ kind: "template" });
      bumpState(source, state, 1);
    } else if (ch === "{") {
      frame.braces += 1;
      bumpState(source, state, 1);
    } else if (ch === "}") {
      if (frame.braces > 0) frame.braces -= 1;
      else if (stack.length > 1) stack.pop();
      bumpState(source, state, 1);
    } else if (isIdentStart(ch)) {
      const index = state.i;
      const line = state.line;
      const column = state.column;
      let end = state.i + 1;
      while (end < source.length && isIdentPart(source[end] ?? "")) end += 1;
      const word = source.slice(state.i, end);
      bumpState(source, state, end - state.i);
      if (word === "export") {
        const saved = { ...state };
        const kind = lookaheadBinding(source, state);
        if (kind) hits.push({ index, line, column, kind });
        else copyState(state, saved);
      }
    } else {
      bumpState(source, state, 1);
    }
    if (state.i === before) bumpState(source, state, 1);
  }
  return hits;
}

function lookaheadBinding(source: string, state: PosState): "const" | "let" | "var" | undefined {
  copyState(state, skipTrivia(source, state));
  const kindStart = state.i;
  const kind = readWord(source, state);
  if (kind !== "const" && kind !== "let" && kind !== "var") {
    state.i = kindStart;
    return undefined;
  }
  copyState(state, skipTrivia(source, state));
  const name = readWord(source, state);
  if (name !== "access") return undefined;
  return kind;
}

function readWord(source: string, state: PosState): string {
  if (!isIdentStart(source[state.i] ?? "")) return "";
  const start = state.i;
  bumpState(source, state, 1);
  while (isIdentPart(source[state.i] ?? "")) bumpState(source, state, 1);
  return source.slice(start, state.i);
}

function skipTrivia(source: string, start: PosState): PosState {
  const state = { ...start };
  let guard = 0;
  while (state.i < source.length && guard <= source.length) {
    guard += 1;
    const ch = source[state.i];
    const next = source[state.i + 1];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      bumpState(source, state, 1);
      continue;
    }
    if (ch === "/" && next === "/") {
      bumpState(source, state, 2);
      while (state.i < source.length && source[state.i] !== "\n" && source[state.i] !== "\r") bumpState(source, state, 1);
      continue;
    }
    if (ch === "/" && next === "*") {
      const comment = { ...state };
      bumpState(source, state, 2);
      while (state.i < source.length && !(source[state.i] === "*" && source[state.i + 1] === "/")) bumpState(source, state, 1);
      if (state.i >= source.length) return comment;
      bumpState(source, state, 2);
      continue;
    }
    break;
  }
  return state;
}

function bumpState(source: string, state: PosState, count: number): void {
  for (let n = 0; n < count; n += 1) {
    const ch = source[state.i];
    if (ch === undefined) return;
    state.i += 1;
    if (ch === "\n") {
      state.line += 1;
      state.column = 1;
    } else if (ch === "\r") {
      state.line += 1;
      state.column = 1;
      if (source[state.i] === "\n") state.i += 1;
    } else {
      state.column += 1;
    }
  }
}

function copyState(target: PosState, source: PosState): void {
  target.i = source.i;
  target.line = source.line;
  target.column = source.column;
}

function formatEnv(env: readonly FunctionAccessEnv[]): string {
  const items = env.map((entry) => quote(entry.optional ? `${entry.name}?` : entry.name));
  return formatList(items);
}

function formatNetwork(network: readonly FunctionAccessNetwork[]): string {
  const items = network.map((entry) => {
    if (isSimpleNetwork(entry)) return quote(entry.origin);
    const fields = [`origin: ${quote(entry.origin)}`];
    if (entry.effect !== "read") fields.push(`effect: ${quote(entry.effect)}`);
    const defaults = entry.effect === "action" ? ACTION_METHODS : READ_METHODS;
    if (!sameList(entry.methods, defaults)) fields.push(`methods: [${entry.methods.map(quote).join(", ")}]`);
    if (entry.path !== "/") fields.push(`path: ${quote(entry.path)}`);
    if (entry.credential !== undefined) fields.push(`credential: ${quote(entry.credential)}`);
    return `{ ${fields.join(", ")} }`;
  });
  return formatList(items);
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "[]";
  const inline = `[${items.join(", ")}]`;
  if (inline.length <= 72) return inline;
  return `[\n${items.map((item) => `    ${item},`).join("\n")}\n  ]`;
}

function isSimpleNetwork(entry: FunctionAccessNetwork): boolean {
  return entry.effect === "read" && sameList(entry.methods, READ_METHODS) && entry.path === "/" && entry.credential === undefined;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

function fileCapabilityId(root: string, filePath: string): string {
  const pathSlug = slug(filePath);
  return pathSlug === "" ? `file_${root}` : `file_${root}_${pathSlug}`;
}

function networkCapabilityId(origin: string): string {
  let host = origin;
  let port = "";
  try {
    const url = new URL(origin);
    host = url.hostname;
    port = url.port;
  } catch {
    host = origin;
  }
  const hostSlug = slug(host) || "host";
  const suffix = port !== "" && port !== "443" ? "_port" : "";
  return `api_${hostSlug}${suffix}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueId(raw: string, taken: Set<string>): string {
  const base = fitId(raw);
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (n < 10000) {
    const suffix = `_${n}`;
    let stem = base.slice(0, 64 - suffix.length).replace(/_+$/g, "");
    if (!/^[a-z]/.test(stem)) stem = "a";
    const next = `${stem}${suffix}`;
    if (ID_PATTERN.test(next) && !taken.has(next)) {
      taken.add(next);
      return next;
    }
    n += 1;
  }
  const fallback = fitId(`a_${fnv6(raw)}_${taken.size}`);
  taken.add(fallback);
  return fallback;
}

function fitId(raw: string): string {
  let id = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(id)) id = `a_${id}`.replace(/^_+|_+$/g, "");
  if (ID_PATTERN.test(id)) return id;
  const suffix = `_${fnv6(raw)}`;
  let stem = id.slice(0, 64 - suffix.length).replace(/_+$/g, "");
  if (!/^[a-z]/.test(stem)) stem = "a";
  const next = `${stem}${suffix}`;
  return ID_PATTERN.test(next) ? next : `a_${fnv6(raw)}`;
}

function fnv6(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_" || ch === "$";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
