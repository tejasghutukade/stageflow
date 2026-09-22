import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const stageId = (() => {
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--stage-id") {
      return process.argv[i + 1] ?? "unknown";
    }
  }
  return "unknown";
})();

const delayByStage = { a: 500, b: 500, c: 100, slow: 30_000 };
const delay = delayByStage[stageId] ?? Number(process.env.MOCK_DELAY ?? "50");
const exitCode = Number(process.env.MOCK_EXIT_CODE ?? "0");

if (process.env.MOCK_DUMP_ENV) {
  const keys = (process.env.MOCK_DUMP_KEYS ?? "").split(",").filter(Boolean);
  const dumped = {};
  for (const key of keys) {
    dumped[key] = process.env[key] ?? null;
  }
  writeFileSync(process.env.MOCK_DUMP_ENV, JSON.stringify(dumped));
}

if (process.env.MOCK_STDERR) {
  process.stderr.write(process.env.MOCK_STDERR);
  if (!process.env.MOCK_STDERR.endsWith("\n")) {
    process.stderr.write("\n");
  }
}
if (process.env.MOCK_STDOUT) {
  process.stdout.write(process.env.MOCK_STDOUT);
  if (
    !process.env.MOCK_STDOUT_PARTIAL &&
    !process.env.MOCK_STDOUT.endsWith("\n")
  ) {
    process.stdout.write("\n");
  }
}
if (process.env.MOCK_STDOUT_BYTES) {
  const bytes = Number(process.env.MOCK_STDOUT_BYTES);
  if (Number.isFinite(bytes) && bytes > 0) {
    const chunk = Buffer.alloc(Math.min(bytes, 64 * 1024), 0x61);
    let remaining = bytes;
    while (remaining > 0) {
      const n = Math.min(remaining, chunk.length);
      process.stdout.write(n === chunk.length ? chunk : chunk.subarray(0, n));
      remaining -= n;
    }
  }
}
if (process.env.MOCK_IPC) {
  const msg = JSON.parse(process.env.MOCK_IPC);
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

if (process.env.MOCK_GRANDCHILD_PID_FILE) {
  const grandchild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1e9)"],
    { stdio: "ignore", detached: false },
  );
  writeFileSync(process.env.MOCK_GRANDCHILD_PID_FILE, String(grandchild.pid));
}

const timer = setTimeout(() => process.exit(exitCode), delay);

if (process.env.MOCK_IGNORE_SIGTERM) {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => {
    clearTimeout(timer);
    const code = process.env.MOCK_SIGTERM_EXIT
      ? Number(process.env.MOCK_SIGTERM_EXIT)
      : 1;
    process.exit(code);
  });
}