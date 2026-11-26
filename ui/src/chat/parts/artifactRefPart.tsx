import { parseUiPart, UI_PART_KIND_ARTIFACT_REF } from "../../../../src/artifacts/uiPart.ts";
import { ArtifactView } from "../../redesign/artifacts/ArtifactView";
import { lookupUiPart, registerUiPart, type UiPartRendererProps } from "./registry";

function ArtifactRefPart({ part, context }: UiPartRendererProps) {
  const parsed = parseUiPart(part);
  if (!parsed.ok) return lookupUiPart("")({ part, context });
  const { key, version, title, fallback } = parsed.part;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[13px] font-medium text-[var(--sf-text-1)]">{title}</div>
      <ArtifactView artifactKey={key} version={version} density="inline" onOpen={context.onOpenConsole} />
      <button
        type="button"
        className="mt-2 text-[12px] text-[var(--sf-text-2)] underline decoration-[var(--sf-hairline)]"
        onClick={() =>
          context.onOpenConsole
            ? context.onOpenConsole(fallback.url)
            : window.open(fallback.url, "_blank", "noopener,noreferrer")
        }
      >
        {fallback.text}
      </button>
    </div>
  );
}

let registered = false;

export function ensureArtifactRefPartRegistered(): void {
  if (registered) return;
  registerUiPart(UI_PART_KIND_ARTIFACT_REF, ArtifactRefPart);
  registered = true;
}