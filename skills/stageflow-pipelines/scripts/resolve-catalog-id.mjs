#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TOP_LEVEL_ID = /^id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/m;
const KINDS = new Set(["pipeline", "stage"]);
const MAX_LEN = 64;

function parseArgs(argv) {
  let text;
  let dir;
  let kind;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--text") {
      text = value;
      i += 1;
      continue;
    }
    if (arg === "--dir") {
      dir = value;
      i += 1;
      continue;
    }
    if (arg === "--kind") {
      kind = value;
      i += 1;
    }
  }
  return { text, dir, kind };
}

function trimToMax(value) {
  let out = value;
  if (out.length > MAX_LEN) {
    out = out.slice(0, MAX_LEN);
  }
  out = out.replace(/-+$/g, "");
  return out;
}

function slugify(text) {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[0-9]/.test(slug)) {
    slug = `x${slug}`;
  }
  if (!slug) {
    slug = "x";
  }
  slug = trimToMax(slug);
  if (!ID_PATTERN.test(slug) || slug.length === 0) {
    slug = "x";
  }
  return slug;
}

function readTopLevelId(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const match = raw.match(TOP_LEVEL_ID);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function existingIds(dir) {
  const ids = new Set();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const id = readTopLevelId(path.join(dir, name));
    if (id) ids.add(id);
  }
  return ids;
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = trimToMax(`${base.slice(0, MAX_LEN - suffix.length)}${suffix}`);
    if (ID_PATTERN.test(candidate) && !taken.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-x`;
}

const { text, dir, kind } = parseArgs(process.argv.slice(2));

if (!KINDS.has(kind)) {
  console.error("resolve-catalog-id: --kind must be pipeline or stage");
  process.exit(1);
}

if (typeof text !== "string" || text.length === 0 || typeof dir !== "string") {
  console.error("resolve-catalog-id: --text, --dir, and --kind are required");
  process.exit(1);
}

const id = uniqueId(slugify(text), existingIds(dir));
process.stdout.write(`${JSON.stringify({ id })}\n`);
