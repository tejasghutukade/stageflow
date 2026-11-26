import { ensureArtifactRefPartRegistered } from "./artifactRefPart";

let ready = false;

export function registerBuiltinUiParts(): void {
  if (ready) return;
  ensureArtifactRefPartRegistered();
  ready = true;
}