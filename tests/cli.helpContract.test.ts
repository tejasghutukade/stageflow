import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

const commands = [
  {
    argv: ["artifact", "read", "--help"],
    usage: "sf artifact read",
    flags: [/--run <runId>/, /--path <relPath>/, /--out <file>/],
  },
  {
    argv: ["envelope", "get", "--help"],
    usage: "sf envelope get",
    flags: [/--format envelope\|handoff/],
  },
  {
    argv: ["export-run", "--help"],
    usage: "sf export-run",
    flags: [/--run <runId>/, /--from <sf-run\.json>/, /--out <file>/],
  },
];

describe("CLI --help contract", { timeout: 30_000 }, () => {
  it.each(commands)("$argv shows usage and exits zero", ({ argv, usage, flags }) => {
    const result = runCli(argv);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain(usage);
    for (const flag of flags) expect(out).toMatch(flag);
  });

  it("top-level --help lists every command", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    for (const { usage } of commands) expect(result.stdout).toContain(usage);
  });
});
