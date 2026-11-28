const input = JSON.parse(process.env.PUBLISH_TEST_INPUT);
process.on("message", (message) => {
  if (message?.type !== "artifact.response") return;
  if (message.error) {
    process.send({ type: "failed", reason: message.error.code ?? "error" });
    process.exit(0);
  }
  const key = message.result?.key;
  if (typeof key === "string" && key.includes("/weekly-note") && message.result.version === 1) {
    process.send({ type: "succeeded" });
  } else {
    process.send({ type: "failed", reason: "bad result" });
  }
  process.exit(0);
});
process.send({
  type: "artifact.publish",
  requestId: "fixture-publish",
  runId: "forged-run",
  stageId: "forged-stage",
  input,
});
setTimeout(() => process.exit(1), 8000).unref();
