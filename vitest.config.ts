import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      STAGEFLOW_MIN_FREE_DISK_BYTES: "0",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      SQLITE_TMPDIR: process.env.SQLITE_TMPDIR ?? process.env.TMPDIR ?? "/tmp",
    },
  },
});
