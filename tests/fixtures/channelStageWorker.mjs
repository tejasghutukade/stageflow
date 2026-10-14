const input = JSON.parse(process.env.CHANNEL_TEST_INPUT);
if (process.env.CH_TEST_TOKEN || process.env.CH_TEST_TOKEN_FILE) {
  process.send({ type: "failed", reason: "channel secret exposed" });
  process.exit(1);
}
if (process.env.MODEL_TEST_SECRET !== "preserved") {
  process.send({ type: "failed", reason: "model configuration missing" });
  process.exit(1);
}
process.on("message", message => {
  if (message.type !== "channel.response") return;
  if (process.env.CHANNEL_EXPECT_ERROR) {
    process.send(message.error?.code === process.env.CHANNEL_EXPECT_ERROR
      ? { type: "succeeded" } : { type: "failed", reason: `expected ${process.env.CHANNEL_EXPECT_ERROR}` });
  } else {
    process.send(message.receipt?.providerMessageId
      ? { type: "succeeded" } : { type: "failed", reason: "no receipt" });
  }
  process.exit(0);
});
process.send({ type: "channel.send", requestId: "fixture-send", runId: "forged-run", stageId: "forged-stage", input });
setTimeout(() => process.exit(1), 5000).unref();
