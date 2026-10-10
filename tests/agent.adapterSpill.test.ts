import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discardAdapterSpill,
  readAdapterSpill,
} from "../src/agent/adapterSpill.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function spillFile(body: string, name = "output-abcd1234.txt"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-output-"));
  cleanup.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, body, "utf8");
  return file;
}

function notice(file: string): string {
  return `preview\n\n[MCP text output truncated: original 10 lines / 80KB. Truncated. Full text saved to: ${file} — use read with offset/limit or grep to inspect.]`;
}

describe("readAdapterSpill", () => {
  it("ignores results the adapter did not truncate", async () => {
    expect(await readAdapterSpill("plain", { server: "exa" })).toEqual({ kind: "none" });
    expect(await readAdapterSpill("plain", undefined)).toEqual({ kind: "none" });
  });

  it("reads the full body from the adapter's spill file", async () => {
    const file = await spillFile("full profile text");
    const spill = await readAdapterSpill(notice(file), {
      outputGuard: { truncated: true, fullOutputPath: file },
    });
    expect(spill).toMatchObject({ kind: "full", text: "full profile text" });
  });

  it("falls back to the path in the notice when details omit it", async () => {
    const file = await spillFile("from notice");
    const spill = await readAdapterSpill(notice(file), { outputGuard: { truncated: true } });
    expect(spill).toMatchObject({ kind: "full", text: "from notice" });
  });

  it("rejects a named file that is not an adapter spill", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-not-spill-"));
    cleanup.push(dir);
    const outside = path.join(dir, "notes.txt");
    await writeFile(outside, "nope", "utf8");
    const wrongName = await spillFile("nope", "secrets.txt");
    for (const file of [outside, wrongName]) {
      expect(
        await readAdapterSpill(notice(file), {
          outputGuard: { truncated: true, fullOutputPath: file },
        }),
      ).toEqual({ kind: "lost", reason: "the MCP adapter's full-output file was not available" });
    }
  });

  it("does not follow a spill symlink outside the temp directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-output-"));
    cleanup.push(dir);
    const outsideDir = await mkdtemp(path.join(tmpdir(), "sf-spill-run-"));
    cleanup.push(outsideDir);
    const outside = path.join(outsideDir, "secret.txt");
    await writeFile(outside, "secret", "utf8");
    const link = path.join(dir, "output-abcd1234.txt");
    await symlink(outside, link);
    const spill = await readAdapterSpill(notice(link), {
      outputGuard: { truncated: true, fullOutputPath: link },
    });
    expect(spill.kind).toBe("lost");
  });

  it("reports the adapter's write error when it could not save the full text", async () => {
    expect(
      await readAdapterSpill("preview", {
        outputGuard: { truncated: true, writeError: "ENOSPC: no space left" },
      }),
    ).toEqual({ kind: "lost", reason: "ENOSPC: no space left" });
  });
});

describe("discardAdapterSpill", () => {
  it("removes the spill file and its directory", async () => {
    const file = await spillFile("x");
    await discardAdapterSpill(file);
    await expect(access(file)).rejects.toThrow();
    await expect(access(path.dirname(file))).rejects.toThrow();
  });
});
