if (process.env.MAIL_SECRET) { process.send({ type: "failed", reason: "secret exposed" }); process.exit(1); }
let selected;
process.on("message", message => {
  if (message.type !== "email.response") return;
  if (process.env.EMAIL_EXPECT_DENIED === "true") {
    process.send(message.error?.code === "EMAIL_UNAUTHORIZED" ? { type: "succeeded" } : { type: "failed", reason: "permission bypass" }); process.exit(0);
  }
  if (message.error) { process.send({ type: "failed", reason: message.error.code }); process.exit(1); }
  if (!selected) {
    selected = message.result.messages[0].ref;
    process.send({ type: "email.getMessage", requestId: "get", input: selected });
  } else {
    process.send(message.result.text?.includes("A provider message.") && message.result.unread ? { type: "succeeded" } : { type: "failed", reason: "missing body" }); process.exit(0);
  }
});
process.send({ type: "email.search", requestId: "search", input: { accountId: process.env.EMAIL_ACCOUNT } });
setTimeout(() => process.exit(1), 5000).unref();
