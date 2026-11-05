import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/hosted.pack.test.ts"],
    // A tsx CLI spawn exceeds the 5s default while a shard's workers are busy.
    testTimeout: 30_000,
    globalSetup: ["tests/globalSetup.socketLeakGuard.ts"],
    setupFiles: ["tests/setup/credentialHomePin.ts"],
    env: {
      STAGEFLOW_MIN_FREE_DISK_BYTES: "0",
      STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS: "0",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      SQLITE_TMPDIR: process.env.SQLITE_TMPDIR ?? process.env.TMPDIR ?? "/tmp",
    },
  },
});
