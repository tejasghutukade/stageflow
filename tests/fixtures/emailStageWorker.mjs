const input = JSON.parse(process.env.EMAIL_TEST_INPUT);
if (process.env.MAIL_SECRET) {
  process.send({ type: "failed", reason: "mailbox secret exposed" });
  process.exit(1);
}
if (process.env.MODEL_TEST_SECRET !== "preserved") {
  process.send({ type: "failed", reason: "model configuration missing" });
  process.exit(1);
}
process.on("message", message => {
  if (message.type !== "email.response") return;
  if (process.env.EMAIL_EXPECT_ERROR) {
    process.send(message.error?.code === process.env.EMAIL_EXPECT_ERROR
      ? { type: "succeeded" } : { type: "failed", reason: "expected permission rejection" });
  } else {
    process.send(message.receipt?.accepted?.length === 1
      ? { type: "succeeded" } : { type: "failed", reason: "no receipt" });
  }
  process.exit(0);
});
process.send({ type: "email.send", requestId: "fixture-send", runId: "forged-run", stageId: "forged-stage", input });
setTimeout(() => process.exit(1), 5000).unref();
