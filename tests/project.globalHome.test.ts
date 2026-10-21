import { describe, expect, it, afterEach } from "vitest";
import { realpathSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { getuid } from "node:process";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  globalStageflowHome,
  resetGlobalStageflowHomeForTests,
  StageflowHomeError,
} from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

describe("globalStageflowHome", () => {
  const prevStageflowHome = process.env.STAGEFLOW_HOME;

  afterEach(() => {
    if (prevStageflowHome === undefined) {
      delete process.env.STAGEFLOW_HOME;
    } else {
      process.env.STAGEFLOW_HOME = prevStageflowHome;
    }
    resetGlobalStageflowHomeForTests();
  });

  it("unset STAGEFLOW_HOME resolves to ~/.stageflow", async () => {
    await withIsolatedHome(async (home) => {
      delete process.env.STAGEFLOW_HOME;
      resetGlobalStageflowHomeForTests();
      expect(globalStageflowHome()).toBe(path.join(home, ".stageflow"));
    });
  });

  it("absolute STAGEFLOW_HOME is used as given", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-abs-home-"));
    try {
      process.env.STAGEFLOW_HOME = dir;
      resetGlobalStageflowHomeForTests();
      expect(globalStageflowHome()).toBe(path.resolve(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("relative STAGEFLOW_HOME resolves against cwd and memoizes", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "sf-rel-work-"));
    const other = await mkdtemp(path.join(tmpdir(), "sf-rel-other-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(work);
      const workReal = realpathSync(work);
      process.env.STAGEFLOW_HOME = "sf-data";
      resetGlobalStageflowHomeForTests();
      const first = globalStageflowHome();
      expect(first).toBe(path.join(workReal, "sf-data"));
      process.env.STAGEFLOW_HOME = path.join(other, "ignored");
      expect(globalStageflowHome()).toBe(first);
    } finally {
      process.chdir(prevCwd);
      await rm(work, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("writes absolute STAGEFLOW_HOME back into process.env after first resolve", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "sf-env-work-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(work);
      process.env.STAGEFLOW_HOME = "sf-data";
      resetGlobalStageflowHomeForTests();
      const resolved = globalStageflowHome();
      expect(process.env.STAGEFLOW_HOME).toBe(resolved);
      expect(path.isAbsolute(process.env.STAGEFLOW_HOME!)).toBe(true);
    } finally {
      process.chdir(prevCwd);
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("assertStageflowHomeWritable", () => {
  const prevStageflowHome = process.env.STAGEFLOW_HOME;

  afterEach(() => {
    if (prevStageflowHome === undefined) {
      delete process.env.STAGEFLOW_HOME;
    } else {
      process.env.STAGEFLOW_HOME = prevStageflowHome;
    }
    resetGlobalStageflowHomeForTests();
  });

  it("store open against mode 0500 directory throws stageflow_home_not_writable", async () => {
    if (getuid() === 0) {
      return;
    }
    const parent = await mkdtemp(path.join(tmpdir(), "sf-ro-parent-"));
    const home = path.join(parent, "home");
    await mkdir(home);
    await chmod(home, 0o500);
    try {
      process.env.STAGEFLOW_HOME = home;
      resetGlobalStageflowHomeForTests();
      const uid = process.getuid!();
      const gid = process.getgid!();
      let err: unknown;
      try {
        createRunStore({ rootDir: globalStageflowHome() });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(StageflowHomeError);
      const homeErr = err as StageflowHomeError;
      expect(homeErr.code).toBe("stageflow_home_not_writable");
      expect(homeErr.message).toContain(String(uid));
      expect(homeErr.message).toContain(String(gid));
      expect(homeErr.message).toContain(home);
      expect(homeErr.message).toMatch(/chown/);
    } finally {
      await chmod(home, 0o700).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    }
  });
});
