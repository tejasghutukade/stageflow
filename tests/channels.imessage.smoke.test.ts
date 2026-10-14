import { describe, expect, it } from "vitest";
import { createPhotonImessageProvider } from "../src/channels/providers/photonImessage.js";

const enabled = process.env.STAGEFLOW_CHANNELS_SMOKE_PHOTON === "1"
  && Boolean(process.env.PHOTON_PROJECT_ID) && Boolean(process.env.PHOTON_PROJECT_SECRET);

/**
 * Opt-in, real Photon project (use a dedicated test project) and the Spectrum packages installed (they are optional dependencies). Run with:
 *   STAGEFLOW_CHANNELS_SMOKE_PHOTON=1 PHOTON_PROJECT_ID=... PHOTON_PROJECT_SECRET=... \
 *   PHOTON_SMOKE_TO=+1... npx vitest run tests/channels.imessage.smoke.test.ts
 * The live check always runs. A message is sent only when PHOTON_SMOKE_TO is set. After the send
 * it reports whether the SDK left handles open, which answers whether a send-only app opens streams.
 */
describe.skipIf(!enabled)("Photon iMessage real project smoke", () => {
  const provider = createPhotonImessageProvider();
  const connection = {
    id: "smoke", scope: "smoke", provider: "imessage", displayName: "smoke", config: {}, secrets: {},
    credential: { id: "photon", provider: "photon", secrets: { projectId: process.env.PHOTON_PROJECT_ID!, projectSecret: process.env.PHOTON_PROJECT_SECRET! } },
  };

  it("passes the live check", async () => {
    expect(await provider.check(connection as never)).toMatchObject({ state: "ok" });
  });

  it.skipIf(!process.env.PHOTON_SMOKE_TO)("checks the recipient, sends one message and leaves no handles open", async () => {
    const target = { recipient: process.env.PHOTON_SMOKE_TO! };
    expect(await provider.checkTargets!(connection as never, [target])).toMatchObject({ state: "ok" });
    const before = process.getActiveResourcesInfo().filter(name => name === "TCPSocketWrap" || name === "TCPWrap").length;
    const receipt = await provider.send(connection as never, target, { text: "Stageflow channel smoke test" }, { operationKey: "smoke" });
    expect(receipt.providerMessageId).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = process.getActiveResourcesInfo().filter(name => name === "TCPSocketWrap" || name === "TCPWrap").length;
    console.log(`open sockets before=${before} after=${after}`);
    expect(after).toBeLessThanOrEqual(before);
  });
});
