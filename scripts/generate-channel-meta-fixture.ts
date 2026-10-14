import { writeFileSync } from "node:fs";
import { CHANNEL_ERROR_INFO } from "../src/channels/errorInfo.js";
import { channelProviders } from "../src/channels/providers.js";
const meta = {
  providers: channelProviders().map(provider => ({ id: provider.id, ...provider.meta })),
  errors: Object.fromEntries(Object.entries(CHANNEL_ERROR_INFO).map(([code, info]) => [code, { reason: info.reason, ...(info.hint ? { hint: info.hint } : {}) }])),
};
writeFileSync(new URL("../ui/src/redesign/connections/metaFixture.json", import.meta.url), `${JSON.stringify(meta, null, 2)}\n`);

