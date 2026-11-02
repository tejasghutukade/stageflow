import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkingTreeFindTool,
  createWorkingTreeGrepTool,
  createWorkingTreeLsTool,
} from "../src/agent/sandboxPiTools.js";
import { grepCommand, runFind, runHostShell, runLs } from "../src/runtime/workspaceSearch.js";

type SearchTool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
};

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("working tree grep, find, and ls", () => {
  it("searches the working tree and rejects a path that leaves it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-host-search-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-host-search-out-"));
    try {
      await mkdir(path.join(cwd, "work"));
      await writeFile(path.join(cwd, "work", "notes.txt"), "tree-needle\n");
      await writeFile(path.join(outside, "secret.txt"), "secret-needle\n");
      await symlink(outside, path.join(cwd, "linkdir"));
      const grep = createWorkingTreeGrepTool(cwd) as SearchTool;
      const find = createWorkingTreeFindTool(cwd) as SearchTool;
      const ls = createWorkingTreeLsTool(cwd) as SearchTool;

      const grepped = await grep.execute("grep", { pattern: "tree-needle", path: "work" });
      expect(grepped.isError).toBeFalsy();
      expect(textOf(grepped)).toContain("notes.txt");

      for (const rejected of ["/etc/passwd", "~/secret", "../passwd"]) {
        const result = await grep.execute("reject", { pattern: "root", path: rejected });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("path escapes the working tree");
      }

      const found = await find.execute("find-link", { pattern: "*", path: "linkdir" });
      expect(found.isError).toBe(true);
      expect(textOf(found)).not.toContain("secret-needle");
      const listed = await ls.execute("ls-link", { path: "linkdir" });
      expect(listed.isError).toBe(true);
      expect(textOf(listed)).not.toContain("secret.txt");

      const link = path.join(cwd, "linkdir");
      await expect(runFind(link, { pattern: "*" }, (command) => runHostShell(cwd, command))).rejects.toThrow(
        /path escapes the working tree/,
      );
      await expect(runLs(link, {}, (command) => runHostShell(cwd, command))).rejects.toThrow(
        /path escapes the working tree/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("stops grep after the match limit", () => {
    const command = grepCommand("/workspace/work", { pattern: "hit", limit: 2 });
    expect(command).toContain("-m 2");
  });
});
