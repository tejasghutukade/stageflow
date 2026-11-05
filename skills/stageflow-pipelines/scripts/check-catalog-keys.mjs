#!/usr/bin/env node

import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const PIPELINE_KEYS = [
  "id", "stages", "model", "independence", "agent", "schemas",
  "requires", "channels", "memories", "include",
];
const FRAGMENT_KEYS = ["stages", "include", "model", "agent", "independence"];
const STAGE_BODY_KEYS = [
  "email", "channels", "system_prompt", "model", "independence", "checkout_context",
  "gate_kinds", "timeout_ms", "skill", "mcp", "secrets", "requires", "browser", "io", "verify",
  "payload_schema", "pre_emit_checks", "clone_input_schema", "completion", "recovery",
];
const STAGE_FILE_KEYS = ["id", "agent", ...STAGE_BODY_KEYS];
const TASK_KEYS = [
  "id", "goal", "context", "constraints", "checkout", "repository", "ref",
  "run_branch_template", "git_identity", "input",
];

function parseArgs(argv) {
  const out = { pipeline: undefined, tasks: [], yamlModule: undefined, sfBin: "sf" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--pipeline" || arg === "--task" || arg === "--yaml-module" || arg === "--sf-bin") {
      if (!value) {
        console.error(`check-catalog-keys: ${arg} requires a value`);
        process.exit(2);
      }
      if (arg === "--pipeline") out.pipeline = value;
      else if (arg === "--task") out.tasks.push(value);
      else if (arg === "--yaml-module") out.yamlModule = value;
      else out.sfBin = value;
      i += 1;
      continue;
    }
    console.error(`check-catalog-keys: unknown argument ${arg}`);
    process.exit(2);
  }
  if (!out.pipeline && out.tasks.length === 0) {
    console.error("check-catalog-keys: pass --pipeline <path> and/or --task <path>");
    process.exit(2);
  }
  return out;
}

function print(payload, code) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function findOnPath(bin) {
  if (bin.includes("/") || bin.includes("\\")) return bin;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function stageflowPackageJson(sfBin) {
  const found = findOnPath(sfBin);
  if (!found) return undefined;
  let dir;
  try {
    dir = path.dirname(realpathSync(found));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const pkg = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(pkg, "utf8"));
      if (parsed.name === "stageflow") return pkg;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function loadYaml(explicit, sfBin) {
  const attempts = [];
  if (explicit) attempts.push(() => path.resolve(explicit));
  attempts.push(() => createRequire(path.join(process.cwd(), "noop.js")).resolve("yaml"));
  attempts.push(() => {
    const pkg = stageflowPackageJson(sfBin);
    if (!pkg) throw new Error("no stageflow package");
    return createRequire(pkg).resolve("yaml");
  });
  attempts.push(() => createRequire(import.meta.url).resolve("yaml"));
  for (const attempt of attempts) {
    try {
      const resolved = attempt();
      const mod = await import(pathToFileURL(resolved).href);
      const parse = mod.parse ?? mod.default?.parse;
      if (typeof parse === "function") return parse;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function suggestion(key, allowed) {
  const norm = key.replace(/-/g, "_").toLowerCase();
  let best;
  for (const candidate of allowed) {
    const distance = levenshtein(norm, candidate);
    if (distance <= 2 && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best ? ` Did you mean "${best.candidate}"?` : "";
}

const findings = [];
function add(severity, code, file, message) {
  findings.push({ severity, code, file, message });
}

function readYamlFile(parse, file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    add("error", "lint.unreadable", file, "File cannot be read.");
    return undefined;
  }
  try {
    return parse(text);
  } catch (err) {
    add("error", "lint.yaml_parse", file, err instanceof Error ? err.message.split("\n")[0] : String(err));
    return undefined;
  }
}

function checkKeys(record, allowed, file, code, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      add("error", code, file, `${label} key "${key}" is not a Stageflow key and is ignored by the loader.${suggestion(key, allowed)}`);
    }
  }
}

function checkId(id, file, label) {
  if (typeof id === "string" && !ID_PATTERN.test(id)) {
    add("error", "lint.id_format", file, `${label} id "${id}" is not lowercase kebab case (^[a-z][a-z0-9]*(-[a-z0-9]+)*$). sf validate accepts it, but the MCP and console create paths reject it.`);
  }
}

function collectStages(parse, file, isFragment, seen, out) {
  const real = path.resolve(file);
  if (seen.has(real)) return;
  seen.add(real);
  const doc = readYamlFile(parse, real);
  if (!isObject(doc)) {
    if (doc !== undefined) add("error", "lint.not_a_mapping", real, "Top level must be a mapping.");
    return;
  }
  if (isFragment) {
    checkKeys(doc, FRAGMENT_KEYS, real, "lint.unknown_fragment_key", "Fragment top-level");
  }
  const dir = path.dirname(real);
  if (Array.isArray(doc.include)) {
    for (const item of doc.include) {
      if (isObject(item) && typeof item.local === "string") {
        collectStages(parse, path.resolve(dir, item.local), true, seen, out);
      }
    }
  }
  if (Array.isArray(doc.stages)) {
    for (const entry of doc.stages) {
      if (isObject(entry)) out.push({ entry, dir, declaringFile: real });
    }
  }
  return doc;
}

function resolveRef(schema, schemas) {
  if (isObject(schema) && typeof schema.$ref === "string") {
    const match = /^#\/schemas\/(.+)$/.exec(schema.$ref);
    if (match && isObject(schemas?.[match[1]])) return resolveRef(schemas[match[1]], schemas);
    return undefined;
  }
  return schema;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function checkValue(value, rawSchema, schemas, where, problems) {
  const schema = resolveRef(rawSchema, schemas);
  if (!isObject(schema)) return;
  if (value === null) {
    if (schema.nullable !== true) problems.push(`${where} is null but the schema is not nullable`);
    return;
  }
  const actual = typeOf(value);
  const expected = schema.type;
  if (typeof expected === "string") {
    const ok = expected === actual || (expected === "number" && actual === "integer");
    if (!ok) {
      problems.push(`${where} is ${actual}, schema wants ${expected}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${where} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) problems.push(`${where} is shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push(`${where} is longer than maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) problems.push(`${where} does not match pattern ${schema.pattern}`);
      } catch {
        // invalid pattern is the validator's job
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${where} is below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${where} is above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) problems.push(`${where} has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) problems.push(`${where} has more than ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, index) => checkValue(item, schema.items, schemas, `${where}[${index}]`, problems));
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) problems.push(`${where}.${key} is required but missing`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) checkValue(child, properties[key], schemas, `${where}.${key}`, problems);
      else if (schema.additionalProperties === false) problems.push(`${where}.${key} is not allowed (additionalProperties: false)`);
    }
  }
}

function checkTask(parse, file, entries, schemas) {
  const task = readYamlFile(parse, path.resolve(file));
  if (!isObject(task)) return;
  const abs = path.resolve(file);
  checkKeys(task, TASK_KEYS, abs, "lint.unknown_task_key", "Task");
  checkId(task.id, abs, "Task");
  if (typeof task.goal !== "string" || task.goal.trim() === "") {
    add("error", "lint.task_goal_missing", abs, "Task needs a non-empty goal.");
  }
  if (task.input !== undefined && !isObject(task.input)) {
    add("error", "lint.task_input_shape", abs, "Task input must be a mapping.");
    return;
  }
  for (const { id, inputSchema } of entries) {
    if (inputSchema === undefined) continue;
    const problems = [];
    checkValue(task.input ?? {}, inputSchema, schemas, "input", problems);
    for (const problem of problems) {
      add("error", "lint.task_input_mismatch", abs, `Entry stage "${id}": ${problem}. Run start would fail with task.invalid_shape.`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const parse = await loadYaml(args.yamlModule, args.sfBin);
if (!parse) {
  print({ ok: false, reason: "yaml_parser_unavailable", hint: "Pass --yaml-module <path to yaml package entry>, or self-check keys by hand." }, 2);
}

let entryInputs = [];
let schemas;
if (args.pipeline) {
  const pipelineFile = path.resolve(args.pipeline);
  try {
    statSync(pipelineFile);
  } catch {
    print({ ok: false, reason: "pipeline_not_found", path: args.pipeline }, 2);
  }
  const stageEntries = [];
  const root = collectStages(parse, pipelineFile, false, new Set(), stageEntries);
  if (isObject(root)) {
    const { browser, ...rest } = root;
    checkKeys(rest, PIPELINE_KEYS, pipelineFile, "lint.unknown_pipeline_key", "Pipeline top-level");
    if (browser !== undefined) {
      add("warning", "lint.pipeline_browser_ignored", pipelineFile, "A pipeline-level browser block is not read by the loader, so no stage gets it. Put browser on each stage body or uses: entry.");
    }
    checkId(root.id, pipelineFile, "Pipeline");
    const stem = path.basename(pipelineFile).replace(/\.pipeline\.ya?ml$/, "");
    if (typeof root.id === "string" && stem !== root.id) {
      add("warning", "lint.pipeline_id_filename", pipelineFile, `Pipeline id "${root.id}" does not match the filename stem "${stem}".`);
    }
    schemas = isObject(root.schemas) ? root.schemas : undefined;
  }
  const anyRoute = stageEntries.some(({ entry }) => Array.isArray(entry.route) && entry.route.length > 0);
  for (const { entry, dir } of stageEntries) {
    checkId(entry.id, pipelineFile, "Stage");
    let body = entry;
    let bodyFile = pipelineFile;
    if (typeof entry.uses === "string") {
      bodyFile = path.resolve(dir, entry.uses);
      const doc = readYamlFile(parse, bodyFile);
      if (!isObject(doc)) continue;
      checkKeys(doc, STAGE_FILE_KEYS, bodyFile, "lint.unknown_stage_key", "Stage file");
      checkId(doc.id, bodyFile, "Stage");
      body = doc;
    }
    const isEntry = entry.entry === true || !anyRoute;
    if (isEntry) {
      const schema = isObject(body.io) && isObject(body.io.input) ? body.io.input.schema : undefined;
      entryInputs.push({ id: typeof entry.id === "string" ? entry.id : String(body.id), inputSchema: schema });
    }
  }
}
for (const task of args.tasks) checkTask(parse, task, entryInputs, schemas);

const errors = findings.filter((f) => f.severity === "error").length;
print({ ok: errors === 0, summary: { errors, warnings: findings.length - errors }, findings }, errors === 0 ? 0 : 1);
