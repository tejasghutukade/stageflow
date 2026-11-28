import type { UiPartArtifactRef } from "../../../../src/artifacts/uiPartArtifactRef.ts";
import { registerBuiltinUiParts } from "../../chat/parts/builtins";
import { renderUiPart } from "../../chat/parts/registry";

export function GuideSavedCard({ part }: { part: UiPartArtifactRef }) {
  registerBuiltinUiParts();
  return <div className="min-w-0">{renderUiPart(part)}</div>;
}
