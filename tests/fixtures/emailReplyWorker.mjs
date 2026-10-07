if (process.env.MAIL_SECRET) { process.send({ type: "failed", reason: "secret exposed" }); process.exit(1); }
const input = JSON.parse(process.env.EMAIL_TEST_INPUT);
let receipt;
process.on("message", message => {
  if (message.type !== "email.response") return;
  if (process.env.EMAIL_EXPECT_DENIED === "true") {
    process.send(message.error?.code === "EMAIL_UNAUTHORIZED" ? { type: "succeeded" } : { type: "failed", reason: "permission bypass" }); process.exit(0);
  }
  if (message.requestId === "get") {
    if (message.error?.code !== "EMAIL_UNAUTHORIZED") { process.send({ type: "failed", reason: "read permission bypass" }); process.exit(1); }
    process.send({ type: "email.reply", requestId: "repeat", input }); return;
  }
  if (message.error) { process.send({ type: "failed", reason: message.error.code }); process.exit(1); }
  if (message.requestId === "reply") {
    receipt = message.receipt;
    if (JSON.stringify(receipt.accepted) !== '["reply@example.com"]') { process.send({ type: "failed", reason: "wrong recipients" }); process.exit(1); }
    process.send({ type: "email.getMessage", requestId: "get", input: input.ref });
  } else if (message.requestId === "repeat") {
    process.send(JSON.stringify(receipt) === JSON.stringify(message.receipt) ? { type: "succeeded" } : { type: "failed", reason: "duplicate submission" }); process.exit(0);
  }
});
process.send({ type: "email.reply", requestId: "reply", input });
setTimeout(() => process.exit(1), 5000).unref();
