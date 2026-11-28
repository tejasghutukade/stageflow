import { useCallback, useMemo, useRef, useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui/ThemeProvider";
import type { ArtifactSnapshot } from "../../../api/artifacts";
import { LIVE_OPENUI_FORMAT } from "../../../api/artifacts";
import { ignoreLiveArtifactAction } from "./actions";
import {
  assessLiveProgramData,
  defaultBindingsMissingSnapshot,
  liveDefaultValueCanon,
  programHasInputs,
  programQueryTools,
  sanitizeLiveViewerState,
} from "./dataState";
import { stageflowRenderLibrary } from "./library";
import { libraryPreviewMessage, liveLibraryVersionStatus } from "./libraryVersion";
import "./openuiStyles";
import { LiveErrorBody, LiveLoadingSkeleton, LiveRefreshAge, LiveStateCard } from "./states";
import { stageflowOpenUiTheme } from "./theme";
import { canonicalJson, clearLiveQueryCache, createLiveToolProvider, liveQueryFromHost, type LiveQuery } from "./toolProvider";
import type { LivePreviewInput } from "../livePreview";

export const LIVE_RENDERER_MARKER = "stageflow-live-renderer";

const theme = stageflowOpenUiTheme();

function ThemedProgram({
  input,
  mountId,
  initialState,
  provider,
  onState,
}: {
  input: LivePreviewInput;
  mountId: string;
  initialState: Record<string, unknown> | undefined;
  provider: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  onState: (state: Record<string, unknown>) => void;
}) {
  return (
    <div className="sf-live-artifact" data-renderer={LIVE_RENDERER_MARKER} data-snapshot-key={mountId} style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }}>
      <ThemeProvider mode="dark" darkTheme={theme} cssSelector=".sf-live-artifact">
        <Renderer
          key={mountId}
          response={input.program}
          library={stageflowRenderLibrary}
          toolProvider={provider}
          initialState={initialState}
          onStateUpdate={onState}
          onAction={ignoreLiveArtifactAction}
          publishObservability={false}
          queryLoader={<span className="sr-only">Loading data</span>}
        />
      </ThemeProvider>
    </div>
  );
}

function awaitingDefaultSnapshot(input: LivePreviewInput): boolean {
  if (input.historical) return false;
  if (!defaultBindingsMissingSnapshot(input.program, input.bindings, input.snapshots)) return false;
  return !input.settled || input.refreshing === true;
}

function previewIdentity(input: LivePreviewInput): string {
  return [
    input.ownerKey,
    input.artifactId,
    input.program,
    input.format ?? "",
    input.library?.name ?? "",
    input.library?.version ?? "",
  ].join("\0");
}

function snapshotsWithVariants(snapshots: readonly ArtifactSnapshot[], variants: ReadonlyMap<string, unknown>): ArtifactSnapshot[] {
  if (variants.size === 0) return snapshots.slice();
  const replaced = new Set<string>();
  const next = snapshots.map((snapshot) => {
    if (!variants.has(snapshot.binding_id)) return snapshot;
    replaced.add(snapshot.binding_id);
    return { ...snapshot, value: variants.get(snapshot.binding_id) };
  });
  for (const [bindingId, value] of variants) {
    if (replaced.has(bindingId)) continue;
    next.push({
      binding_id: bindingId,
      args_hash: "",
      value,
      fetched_at: "",
      duration_ms: 0,
      status: "ok",
      error_code: null,
    });
  }
  return next;
}

export function LiveArtifactRenderer(input: LivePreviewInput) {
  const canon = liveDefaultValueCanon(input.bindings, input.snapshots);
  const identity = previewIdentity(input);
  const stateRef = useRef<Record<string, unknown> | undefined>(undefined);
  const variantRef = useRef(new Map<string, unknown>());
  const sawRefreshing = useRef(false);
  const mountRef = useRef<{ canon: string; identity: string; id: number; initial?: Record<string, unknown> } | null>(null);
  const onResultRef = useRef<(event: { bindingId: string; value: unknown; usedDefault: boolean }) => void>(() => undefined);
  const [variantEpoch, setVariantEpoch] = useState(0);

  if (mountRef.current === null) {
    mountRef.current = { canon, identity, id: 0 };
  } else if (mountRef.current.identity !== identity) {
    clearLiveQueryCache();
    stateRef.current = undefined;
    variantRef.current.clear();
    mountRef.current = { canon, identity, id: mountRef.current.id + 1 };
  } else if (mountRef.current.canon !== canon) {
    clearLiveQueryCache();
    mountRef.current = {
      canon,
      identity,
      id: mountRef.current.id + 1,
      initial: sanitizeLiveViewerState(stateRef.current, input.program),
    };
  }
  if (input.refreshing === true && !sawRefreshing.current) clearLiveQueryCache();
  sawRefreshing.current = input.refreshing === true;

  onResultRef.current = (event) => {
    const had = variantRef.current.has(event.bindingId);
    if (event.usedDefault) {
      if (!had) return;
      variantRef.current.delete(event.bindingId);
    } else {
      if (had && Object.is(variantRef.current.get(event.bindingId), event.value)) return;
      variantRef.current.set(event.bindingId, event.value);
    }
    setVariantEpoch((epoch) => epoch + 1);
  };

  const bindingKey = canonicalJson(input.bindings.map((binding) => ({ id: binding.id, function: binding.function, args: binding.args })));
  const query = useMemo<LiveQuery>(
    () => input.query ?? liveQueryFromHost(input.ownerKey, input.artifactId, input.projectRoot),
    [input.query, input.ownerKey, input.artifactId, input.projectRoot],
  );
  const provider = useMemo(
    () =>
      createLiveToolProvider({
        bindings: input.bindings,
        snapshots: input.snapshots,
        historical: input.historical,
        cacheScope: `${input.ownerKey}\0${input.artifactId}`,
        query,
        onResult: (event) => onResultRef.current(event),
      }),
    [bindingKey, canon, input.historical, input.ownerKey, input.artifactId, query],
  );
  const onState = useCallback((state: Record<string, unknown>) => {
    stateRef.current = state;
  }, []);

  const format = input.format ?? LIVE_OPENUI_FORMAT;
  const version = liveLibraryVersionStatus(input.library);
  if (format !== LIVE_OPENUI_FORMAT) {
    return (
      <div>
        <LiveStateCard title="Cannot preview this format" body={`Format ${format} has no renderer.`} role="alert" />
      </div>
    );
  }
  if (version !== "current") {
    return (
      <div>
        <LiveStateCard title={libraryPreviewMessage(input.library)} role="status" />
      </div>
    );
  }
  if (awaitingDefaultSnapshot(input)) {
    return (
      <div>
        <LiveLoadingSkeleton />
      </div>
    );
  }
  if (input.status === "error" && input.snapshots.length === 0 && input.refreshing !== true) {
    return (
      <div>
        <LiveStateCard title="Error" role="alert">
          <LiveErrorBody code={input.lastErrorCode} fallback="The last refresh failed." />
        </LiveStateCard>
      </div>
    );
  }
  const assessed = assessLiveProgramData(input.program, input.bindings, input.snapshots);
  const shown = assessLiveProgramData(
    input.program,
    input.bindings,
    snapshotsWithVariants(input.snapshots, variantRef.current),
  );
  const hasInputs = programHasInputs(input.program);
  const hasQuery = programQueryTools(input.program).length > 0;
  const stale = input.status === "stale" ? (
    <LiveStateCard title="Stale">
      <p className="mt-1 text-[13px] text-[var(--sf-text-2)]">
        Last refreshed <LiveRefreshAge iso={input.lastRefreshedAt} />
      </p>
      {input.lastErrorCode ? <LiveErrorBody code={input.lastErrorCode} /> : null}
    </LiveStateCard>
  ) : input.status === "error" ? (
    <LiveStateCard title="Error" role="alert">
      <LiveErrorBody code={input.lastErrorCode} fallback="A refresh failed. The last snapshot is shown." />
    </LiveStateCard>
  ) : null;
  const historical = input.historical && input.snapshots.length > 0 ? (
    <LiveStateCard title="Snapshots are for the current version: data shown is the latest" />
  ) : input.historical && hasQuery ? (
    <LiveStateCard title="No data for this version" />
  ) : null;
  const replace = !hasInputs && (assessed.state === "empty" || assessed.state === "mismatch");
  const filteredNote = hasInputs && assessed.state === "empty" && shown.state === "ok" ? (
    <p role="status" data-sf-state="filtered" data-variant-epoch={variantEpoch} className="text-[13px] text-[var(--sf-text-2)]">
      Showing filtered data
    </p>
  ) : null;
  const emptyBanner = hasInputs && shown.state === "empty" ? (
    <LiveStateCard title="No data" body="The bound result has no rows." />
  ) : null;
  const mismatchBanner = hasInputs && assessed.state === "mismatch" ? (
    <LiveStateCard title="Data mismatch" body={assessed.missing.join(", ") || "A field in the program is missing from the result."} role="alert" />
  ) : null;
  const session = mountRef.current;
  let body = (
    <ThemedProgram
      input={input}
      mountId={String(session.id)}
      initialState={session.initial}
      provider={provider}
      onState={onState}
    />
  );
  if (replace && assessed.state === "empty") body = <LiveStateCard title="No data" body="The bound result has no rows." />;
  if (replace && assessed.state === "mismatch") {
    body = <LiveStateCard title="Data mismatch" body={assessed.missing.join(", ") || "A field in the program is missing from the result."} role="alert" />;
  }
  return (
    <div className="flex flex-col gap-3">
      {historical}
      {stale}
      {filteredNote}
      {emptyBanner}
      {mismatchBanner}
      {body}
    </div>
  );
}
