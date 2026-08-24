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

if (process.env.MOCK_STDERR) {
  process.stderr.write(process.env.MOCK_STDERR);
  if (!process.env.MOCK_STDERR.endsWith("\n")) {
    process.stderr.write("\n");
  }
}

if (process.env.MOCK_IPC) {
  const msg = JSON.parse(process.env.MOCK_IPC);
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

const timer = setTimeout(() => process.exit(exitCode), delay);

process.on("SIGTERM", () => {
  clearTimeout(timer);
  const code = process.env.MOCK_SIGTERM_EXIT
    ? Number(process.env.MOCK_SIGTERM_EXIT)
    : 1;
  process.exit(code);
});
