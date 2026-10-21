import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { defaultSocketRoot } from "../src/browser/localBrowserHost.js";

const root = defaultSocketRoot(process.platform);
let before = new Set<string>();

function entries(): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

export function setup(): void {
  before = new Set(entries());
}

export function teardown(): void {
  const leaked = entries().filter((name) => !before.has(name));
  if (leaked.length === 0) return;
  for (const name of leaked) rmSync(path.join(root, name), { recursive: true, force: true });
  throw new Error(
    `tests leaked ${leaked.length} socket folder(s) under ${root}; inject a per-test socketRoot and remove it in afterEach`,
  );
}
