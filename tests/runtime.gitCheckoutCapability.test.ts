import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCheckoutCapability } from "../src/runtime/gitCheckoutCapability.js";

const roots: string[] = [];

function git(root: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createGitCheckoutCapability", () => {
  it("reports only changes made after its baseline, including untracked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-checkout-capability-"));
    roots.push(root);
    await git(root, ["init"]);
    await writeFile(path.join(root, "tracked.txt"), "before\n");
    await writeFile(path.join(root, "preexisting.txt"), "already here\n");
    await git(root, ["add", "tracked.txt"]);

    const checkout = createGitCheckoutCapability(root);
    const before = await checkout.capture();
    await writeFile(path.join(root, "tracked.txt"), "after\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    await rm(path.join(root, "preexisting.txt"));

    await expect(checkout.changesSince(before)).resolves.toEqual([
      { path: "new.txt", status: "untracked" },
      { path: "preexisting.txt", status: "deleted" },
      { path: "tracked.txt", status: "modified" },
    ]);
  });
});
