const reports = JSON.parse(process.env.PUBLISH_REPORT_INPUT ?? "[]");
let done = 0;
process.on("message", (message) => {
  if (message?.type !== "artifact.response") return;
  if (message.error) {
    process.send({ type: "failed", reason: message.error.code ?? "error" });
    process.exit(0);
  }
  done += 1;
  if (done >= reports.length) {
    process.send({ type: "succeeded" });
    process.exit(0);
  }
});
for (const [index, input] of reports.entries()) {
  process.send({
    type: "artifact.publish",
    requestId: `fixture-publish-${index}`,
    runId: "forged-run",
    stageId: "forged-stage",
    input,
  });
}
setTimeout(() => process.exit(1), 8000).unref();