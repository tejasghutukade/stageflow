import { ensureApprovalPartRegistered } from "./approvalPart";
import { ensureArtifactRefPartRegistered } from "./artifactRefPart";
import { ensureFormPartRegistered } from "./formPart";

let ready = false;

export function registerBuiltinUiParts(): void {
  if (ready) return;
  ensureArtifactRefPartRegistered();
  ensureFormPartRegistered();
  ensureApprovalPartRegistered();
  ready = true;
}