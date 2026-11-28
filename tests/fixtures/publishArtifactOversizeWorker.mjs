const length = Number(process.env.PUBLISH_OVERSIZE_B64);
process.on("message", (message) => {
  if (message?.type !== "artifact.response") return;
  process.send({ type: "failed", reason: message.error?.code ?? "missing" });
  process.exit(0);
});
process.send({
  type: "artifact.publish",
  requestId: "oversize-publish",
  input: {
    id: "weekly-note",
    kind: "static.text",
    title: "Big",
    content_base64: "A".repeat(length),
  },
});
setTimeout(() => process.exit(1), 8000).unref();
