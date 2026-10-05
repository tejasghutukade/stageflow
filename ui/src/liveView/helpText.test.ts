import { describe, expect, it } from "vitest";
import { LIVE_VIEW_HELP } from "./helpText";

describe("LIVE_VIEW_HELP", () => {
  const text = LIVE_VIEW_HELP.toLowerCase();

  it.each([
    ["passkeys and security keys", /passkey/, /security key/],
    ["permission requests", /permission request/],
    ["file pickers", /file picker/],
    ["browser sign-in boxes", /browser sign-in box/],
    ["cancel or choose another method", /cancel/, /another sign-in method/, /code/, /sms/, /backup code/],
  ])("mentions %s", (_name, ...patterns) => {
    for (const pattern of patterns) expect(text).toMatch(pattern);
  });
});
