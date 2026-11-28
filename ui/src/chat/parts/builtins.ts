import { ensureApprovalPartRegistered } from "./approvalPart";
import { ensureArtifactRefPartRegistered } from "./artifactRefPart";
import { ensureCardPartRegistered } from "./cardPart";
import { ensureFormPartRegistered } from "./formPart";

let ready = false;

export function registerBuiltinUiParts(): void {
  if (ready) return;
  ensureArtifactRefPartRegistered();
  ensureCardPartRegistered();
  ensureFormPartRegistered();
  ensureApprovalPartRegistered();
  ready = true;
}