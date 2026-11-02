import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCheckoutAgentsContext } from "../src/agent/checkoutContext.js";
import type { StageRunInput } from "../src/agent/port.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function input(checkoutRoot: string): StageRunInput {
  return {
    stage: { checkout_context: true },
    roots: { checkoutRoot },
  } as StageRunInput;
}

describe("readCheckoutAgentsContext", () => {
  it("includes a regular file and caps it at 20000 characters", async () => {
    const checkout = await temp("sf-checkout-ctx-");
    const body = `RULE ${"x".repeat(25_000)}`;
    await writeFile(path.join(checkout, "AGENTS.md"), body);
    const text = await readCheckoutAgentsContext(input(checkout));
    expect(text).toContain("RULE");
    expect(text).toContain("The stage assignment wins where it conflicts with the file.");
    expect(text?.includes("x".repeat(20_001))).toBe(false);
  });

  it("does not follow a symlink or a hard link out of the checkout", async () => {
    const checkout = await temp("sf-checkout-ctx-link-");
    const outside = await temp("sf-checkout-ctx-out-");
    await writeFile(path.join(outside, "auth.json"), "API_KEY=super-secret\n");
    await symlink(path.join(outside, "auth.json"), path.join(checkout, "AGENTS.md"));
    expect(await readCheckoutAgentsContext(input(checkout))).toBeUndefined();

    await rm(path.join(checkout, "AGENTS.md"));
    await link(path.join(outside, "auth.json"), path.join(checkout, "AGENTS.md"));
    const hard = await readCheckoutAgentsContext(input(checkout));
    expect(hard).toBeUndefined();
  });
});
