import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBackupCommand } from "../src/cli/backupCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

describe("sf backup CLI", () => {
  it("writes default archive under backups/ with json metadata", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      createRunStore({ rootDir: home, openerMode: "migrate" });
      mkdirSync(path.join(home, "agent"), { recursive: true });
      writeFileSync(path.join(home, "agent", "auth.json"), "{}\n", {
        mode: 0o600,
      });

      const lines: string[] = [];
      const code = await runBackupCommand(["--json", "--db-only"], {
        io: {
          log: (line) => lines.push(line),
          error: (line) => lines.push(line),
        },
      });
      expect(code).toBe(0);
      const payload = JSON.parse(lines.find((l) => l.startsWith("{"))!);
      expect(payload.path).toContain(path.join(home, "backups"));
      expect(existsSync(payload.path)).toBe(true);
      expect(payload.contents).toEqual(["state.db"]);
    });
  });

  it("refuses --out under worktrees", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      createRunStore({ rootDir: home, openerMode: "migrate" });
      const out = path.join(home, "worktrees", "x", "bad.db");
      mkdirSync(path.dirname(out), { recursive: true });
      const errors: string[] = [];
      const code = await runBackupCommand(["--db-only", "--out", out], {
        io: {
          log: () => undefined,
          error: (line) => errors.push(line),
        },
      });
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/backup_out_denied/);
    });
  });
});
