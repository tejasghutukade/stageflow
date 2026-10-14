import { Type } from "typebox";
import { MAX_MESSAGE_TEXT, channelFault, type ChannelSendInput, type StageChannels } from "../channels/host.js";

export function createSendMessageTool(channels: StageChannels) {
  return {
    name: "send_message",
    label: "Send message",
    description: "Send a message on one of this stage's declared communication channels. The recipient is fixed by Stageflow configuration and cannot be chosen. Pass the channel alias when the stage declares more than one. Reuse the same operationKey when retrying the same message. Acceptance means provider submission, not delivery or that anyone read it. Never retry an unknown outcome with a new key. Do not put secrets in a message.",
    parameters: Type.Object({
      channel: Type.Optional(Type.String()),
      text: Type.String({ maxLength: MAX_MESSAGE_TEXT }),
      subject: Type.Optional(Type.String()),
      operationKey: Type.String(),
    }),
    async execute(_toolCallId: string, input: unknown): Promise<{ content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }> {
      try {
        const receipt = await channels.send(input as ChannelSendInput);
        return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: receipt };
      } catch (error) {
        const details = channelFault(error);
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: true };
      }
    },
  };
}
