import { useEffect, useState } from "react";
import { parseUiPart, UI_PART_KIND_ARTIFACT_REF, UI_PART_KIND_ERROR } from "../../../../src/artifacts/uiPart.ts";
import { fetchArtifact, promoteArtifact } from "../../api/artifacts";
import { ArtifactView } from "../../redesign/artifacts/ArtifactView";
import { lookupUiPart, registerUiPart, type UiPartRendererProps } from "./registry";

function projectFromFallback(url: string): string | undefined {
  try {
    return new URL(url, "http://127.0.0.1").searchParams.get("project_root") ?? undefined;
  } catch {
    return undefined;
  }
}

function PromoteSessionArtifact({ artifactKey, projectRoot }: { artifactKey: string; projectRoot?: string }) {
  const [scope, setScope] = useState<"session" | "project" | "unknown">("unknown");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const slash = artifactKey.lastIndexOf("/");
    const owner = artifactKey.slice(0, slash);
    const id = artifactKey.slice(slash + 1);
    if (!owner || !id) return;
    let cancelled = false;
    void fetchArtifact(owner, id, projectRoot)
      .then((record) => {
        if (!cancelled) setScope(record.scope === "session" ? "session" : "project");
      })
      .catch(() => {
        if (!cancelled) setScope("project");
      });
    return () => {
      cancelled = true;
    };
  }, [artifactKey, projectRoot]);
  if (scope !== "session") return null;
  return (
    <button
      type="button"
      className="mt-2 text-[12px] text-[var(--sf-text-1)] underline decoration-[var(--sf-hairline)] disabled:opacity-60"
      disabled={busy}
      onClick={() => {
        const slash = artifactKey.lastIndexOf("/");
        setBusy(true);
        setNote(null);
        void promoteArtifact(artifactKey.slice(0, slash), artifactKey.slice(slash + 1), projectRoot)
          .then(() => setScope("project"))
          .catch(() => setNote("Could not keep this artifact"))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Keeping…" : "Promote"}
      {note ? <span className="ml-2 text-[var(--sf-fail)]">{note}</span> : null}
    </button>
  );
}

function ErrorPart({ part }: UiPartRendererProps) {
  const record = typeof part === "object" && part !== null ? (part as { title?: unknown; message?: unknown }) : {};
  const title = typeof record.title === "string" ? record.title : "Could not show that";
  const message = typeof record.message === "string" ? record.message : "That could not be shown.";
  return (
    <div role="alert" className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-3 py-2 text-[13px] text-[var(--sf-text-1)]">
      <p className="m-0 font-medium">{title}</p>
      <p className="mt-1 mb-0 text-[var(--sf-text-2)]">{message}</p>
    </div>
  );
}

export function InlinePreviewCard({ phase, message }: { phase: "skeleton" | "error"; message?: string }) {
  if (phase === "error") {
    return (
      <div role="alert" className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-3 py-2 text-[13px] text-[var(--sf-text-1)]">
        <p className="m-0 font-medium">Could not show that</p>
        <p className="mt-1 mb-0 text-[var(--sf-text-2)]">{message || "That could not be shown."}</p>
      </div>
    );
  }
  return (
    <div role="status" aria-label="Preparing a view" className="h-16 animate-pulse rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)]" />
  );
}

function ArtifactRefPart({ part, context }: UiPartRendererProps) {
  const parsed = parseUiPart(part);
  if (!parsed.ok) return lookupUiPart("")({ part, context });
  const { key, version, title, fallback } = parsed.part;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[13px] font-medium text-[var(--sf-text-1)]">{title}</div>
      <ArtifactView artifactKey={key} version={version} density="inline" onOpen={context.onOpenConsole} chat={context.chat} />
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
      <PromoteSessionArtifact artifactKey={key} projectRoot={projectFromFallback(fallback.url)} />
    </div>
  );
}

let registered = false;

export function ensureArtifactRefPartRegistered(): void {
  if (registered) return;
  registerUiPart(UI_PART_KIND_ARTIFACT_REF, ArtifactRefPart);
  registerUiPart(UI_PART_KIND_ERROR, ErrorPart);
  registered = true;
}