const input = JSON.parse(process.env.EMAIL_TEST_INPUT);
const ref = JSON.parse(process.env.EMAIL_TEST_REF);
if (process.env.MAIL_SECRET) process.exit(1);
let step = 0;
function send(type, requestId, input) {
  process.send({ type, requestId, runId: "forged", stageId: "forged", workspaceDir: "/tmp", input });
}
process.on("message", message => {
  if (message.type !== "email.response") return;
  if (step === 0) {
    if (message.error?.code !== "EMAIL_INVALID_INPUT") process.exit(1);
    step++;
    send("email.send", "send", input);
  } else if (step === 1) {
    if (message.receipt?.accepted?.length !== 1) process.exit(1);
    step++;
    send("email.downloadAttachment", "download", { ref, attachmentId: "0" });
  } else {
    process.send(message.result?.artifact?.startsWith("stages/notify/attempts/2/artifacts/email-") && !message.result?.content
      ? { type: "succeeded" } : { type: "failed", reason: "no bounded artifact result" });
    process.exit(0);
  }
});
send("email.send", "forged", { ...input, workspaceDir: "/tmp", runId: "forged", stageId: "forged" });
setTimeout(() => process.exit(1), 10000).unref();
