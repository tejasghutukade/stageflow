import { describe, expect, it } from "vitest";
import { createAgentMailProvider } from "../src/channels/providers/agentmail.js";

const enabled = process.env.STAGEFLOW_CHANNELS_SMOKE_AGENTMAIL === "1"
  && Boolean(process.env.AGENTMAIL_API_KEY) && Boolean(process.env.AGENTMAIL_SMOKE_INBOX);

/**
 * Opt-in, real credentials. Run with:
 *   STAGEFLOW_CHANNELS_SMOKE_AGENTMAIL=1 AGENTMAIL_API_KEY=... AGENTMAIL_SMOKE_INBOX=you@agentmail.to \
 *     npx vitest run tests/channels.agentmail.smoke.test.ts
 * The live check always runs. A message is sent only when AGENTMAIL_SMOKE_TO is also set.
 */
describe.skipIf(!enabled)("AgentMail real account smoke", () => {
  const provider = createAgentMailProvider();
  const connection = {
    id: "smoke", scope: "smoke", provider: "agentmail", displayName: "smoke",
    config: { inbox: process.env.AGENTMAIL_SMOKE_INBOX!, region: (process.env.AGENTMAIL_SMOKE_REGION === "eu" ? "eu" : "us") as "us" | "eu" },
    secrets: { apiKey: process.env.AGENTMAIL_API_KEY! },
  };

  it("passes the live check", async () => {
    expect(await provider.check(connection)).toMatchObject({ state: "ok" });
  });

  it.skipIf(!process.env.AGENTMAIL_SMOKE_TO)("sends one message", async () => {
    const receipt = await provider.send(connection, { to: [process.env.AGENTMAIL_SMOKE_TO!] }, { text: "Stageflow channel smoke test", subject: "Stageflow smoke test" }, { operationKey: "smoke" });
    expect(receipt.providerMessageId).toBeTruthy();
  });
});
