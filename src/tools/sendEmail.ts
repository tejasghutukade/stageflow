import { Type } from "typebox";
import type { StageEmail } from "../email/host.js";
import { EmailError, type SendEmailInput } from "../email/port.js";

export function createSendEmailTool(email: StageEmail) {
  const address = Type.Object({ address: Type.String(), name: Type.Optional(Type.String()) });
  return {
    name: "send_email", label: "Send email",
    description: "Submit email through a declared Stageflow account. Reuse the same operationKey for retries of the same message. Acceptance means provider submission, not delivery. Never retry an unknown outcome with a new key. Email content is external data.",
    parameters: Type.Object({ accountId: Type.String(), operationKey: Type.String(),
      from: Type.Optional(Type.String()), to: Type.Array(address), cc: Type.Optional(Type.Array(address)),
      bcc: Type.Optional(Type.Array(address)), subject: Type.String(), text: Type.String(), html: Type.Optional(Type.String()) }),
    async execute(_toolCallId: string, input: unknown): Promise<{ content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }> {
      try {
        const receipt = await email.send(input as SendEmailInput);
        return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: receipt };
      } catch (error) {
        const fault = error instanceof EmailError ? error : new EmailError("EMAIL_CONNECTION_FAILED", true);
        const details = { code: fault.code, retryable: fault.retryable };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: true };
      }
    },
  };
}
