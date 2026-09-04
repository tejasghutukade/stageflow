import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readCompletionCheckoutBaseline,
  writeCompletionCheckoutBaseline,
} from "../src/runtime/completionCheckoutBaseline.js";

describe("completion checkout baseline", () => {
  it("persists and reloads an attempt baseline for a resumed stage", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-completion-baseline-"));
    const snapshot = {
      entries: [{ path: "src/app.ts", fingerprint: "tracked:file:before" }],
    };

    await expect(
      readCompletionCheckoutBaseline(workspace, "implement", 1),
    ).resolves.toBeUndefined();
    await writeCompletionCheckoutBaseline(workspace, "implement", 1, snapshot);
    await expect(
      readCompletionCheckoutBaseline(workspace, "implement", 1),
    ).resolves.toEqual(snapshot);

    const file = path.join(
      workspace,
      "stages",
      "implement",
      "attempts",
      "1",
      "completion-checkout-before.json",
    );
    await writeFile(file, "not json\n");
    await expect(
      readCompletionCheckoutBaseline(workspace, "implement", 1),
    ).rejects.toThrow(/baseline is unreadable/);
  });
});
