import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A 16-character random link token. The link is the credential, so it comes from the CSPRNG. */
export function newWebChatSlug(): string {
  let slug = "";
  for (let index = 0; index < 16; index += 1) slug += ALPHABET[randomInt(ALPHABET.length)];
  return slug;
}
