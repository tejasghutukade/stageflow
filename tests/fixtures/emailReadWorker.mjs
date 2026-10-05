if (process.env.MAIL_SECRET) { process.send({ type: "failed", reason: "secret exposed" }); process.exit(1); }
const query = { accountId: process.env.EMAIL_ACCOUNT, unread: true, from: "sender@example.com", limit: 1 };
process.on("message", message => {
  if (message.type !== "email.response") return;
  if (process.env.EMAIL_EXPECT_DENIED === "true") {
    process.send(message.error?.code === "EMAIL_UNAUTHORIZED" ? { type: "succeeded" } : { type: "failed", reason: "permission bypass" }); process.exit(0);
  }
  if (message.requestId === "unsupported") {
    const correct = message.error?.code === "EMAIL_SEARCH_UNSUPPORTED" && JSON.stringify(message.error.unsupportedFields) === '["text","hasAttachments"]';
    process.send(correct ? { type: "succeeded" } : { type: "failed", reason: "missing unsupported fields" }); process.exit(0);
  }
  if (message.error) { process.send({ type: "failed", reason: message.error.code }); process.exit(1); }
  if (message.requestId === "search") {
    if (!message.result.nextCursor) { process.send({ type: "failed", reason: "missing next page" }); process.exit(1); }
    process.send({ type: "email.search", requestId: "page", input: { ...query, cursor: message.result.nextCursor } });
  } else if (message.requestId === "page") {
    process.send({ type: "email.getMessage", requestId: "get", input: message.result.messages[0].ref });
  } else if (message.requestId === "get") {
    if (!message.result.text?.includes("A provider message.") || !message.result.unread) { process.send({ type: "failed", reason: "missing body" }); process.exit(1); }
    process.send({ type: "email.search", requestId: "unsupported", input: { ...query, text: "body", hasAttachments: false } });
  }
});
process.send({ type: "email.search", requestId: "search", input: query });
setTimeout(() => process.exit(1), 5000).unref();
