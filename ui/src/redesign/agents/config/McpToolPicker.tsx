import { useEffect, useRef, useState } from "react";
import { LuRefreshCw } from "react-icons/lu";
import type { McpToolInfo } from "../../../api";
import { projectMcpApi, type ProjectMcpApi } from "../../settings/mcpApi";
import { MONO } from "../agentsTokens";
import { filterRows, setMany, toggleTool, toolRows } from "../model/mcpTools";
import { ChipListField } from "../ui";

const SEARCH_FROM = 8;

type Load =
  | { state: "loading" }
  | { state: "ready"; tools: McpToolInfo[] }
  | { state: "none" }
  | { state: "failed"; message: string };

/**
 * Checkboxes for the tools a server offers. The list comes from what the Host saw the last time it
 * connected; Refresh connects again. When the server cannot be reached the field falls back to typed
 * names so an agent can still be configured.
 */
export function McpToolPicker({
  server,
  granted,
  onChange,
  api = projectMcpApi,
}: {
  server: string;
  granted: string[];
  onChange?: (tools: string[]) => void;
  api?: Pick<ProjectMcpApi, "probe" | "tools">;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const live = useRef(true);
  const probing = useRef<AbortController | null>(null);

  const refresh = async () => {
    probing.current?.abort();
    const controller = new AbortController();
    probing.current = controller;
    setBusy(true);
    try {
      const result = await api.probe(server, { signal: controller.signal });
      if (!live.current || controller.signal.aborted) return;
      if (result.status === "connected" && result.tools) setLoad({ state: "ready", tools: result.tools });
      else
        setLoad({
          state: "failed",
          message:
            result.status === "needs_auth"
              ? "This server needs sign-in. Sign in from Settings → Project MCP, then refresh."
              : result.error ?? `Could not connect (${result.status.replace(/_/g, " ")}).`,
        });
    } catch (err) {
      if (live.current && !controller.signal.aborted) setLoad({ state: "failed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (live.current && probing.current === controller) setBusy(false);
    }
  };

  useEffect(() => {
    live.current = true;
    setLoad({ state: "loading" });
    api.tools(server).then(
      (result) => {
        if (!live.current) return;
        if (result.tools) setLoad({ state: "ready", tools: result.tools });
        else {
          setLoad({ state: "none" });
          void refresh();
        }
      },
      () => live.current && setLoad({ state: "none" }),
    );
    return () => {
      live.current = false;
      probing.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  if (load.state === "loading" || (busy && load.state === "none")) {
    return <span className="text-xs text-[var(--sf-text-3)]">Loading tools…</span>;
  }

  const typed = (message?: string) => (
    <div className="flex flex-col gap-1.5">
      {message ? <span className="text-xs text-[var(--sf-text-3)]">{message}</span> : null}
      <ChipListField
        values={granted}
        onChange={onChange}
        placeholder="Tool names this agent may call, e.g. search"
        ariaLabel={`${server} tools`}
      />
      <button type="button" className="w-fit text-xs text-[var(--sf-text-2)] underline" disabled={busy} onClick={() => void refresh()}>
        {busy ? "Connecting…" : "Try to load the tool list"}
      </button>
    </div>
  );

  if (load.state === "failed") return typed(load.message);
  if (load.state === "none") return typed("No tool list yet.");

  const rows = toolRows(load.tools, granted);
  const shown = filterRows(rows, query);
  const names = shown.map((row) => row.name);
  const allShownOn = names.length > 0 && names.every((name) => granted.includes(name));

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={`${server} tools`}>
      <div className="flex items-center gap-2">
        {rows.length >= SEARCH_FROM ? (
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--sf-hairline-strong)] bg-transparent px-2 text-xs text-[var(--sf-text-1)] outline-none"
            placeholder="Filter tools"
            aria-label={`Filter ${server} tools`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : (
          <span className="flex-1 text-xs text-[var(--sf-text-3)]">
            {load.tools.length} tool{load.tools.length === 1 ? "" : "s"} on this server
          </span>
        )}
        {onChange ? (
          <button
            type="button"
            className="text-xs text-[var(--sf-text-2)] underline disabled:opacity-50"
            disabled={names.length === 0}
            onClick={() => onChange(setMany(granted, names, !allShownOn))}
          >
            {allShownOn ? "Clear" : query ? "Select shown" : "Select all"}
          </button>
        ) : null}
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-[var(--sf-text-2)] disabled:opacity-50"
          disabled={busy}
          aria-label={`Refresh ${server} tools`}
          onClick={() => void refresh()}
        >
          <LuRefreshCw aria-hidden className={`size-3 ${busy ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
      <div className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-[var(--sf-hairline-strong)]">
        {shown.length === 0 ? (
          <span className="px-3 py-2 text-xs text-[var(--sf-text-3)]">{rows.length === 0 ? "This server lists no tools." : "No tools match."}</span>
        ) : (
          shown.map((row) => (
            <label key={row.name} className="flex cursor-pointer items-start gap-2.5 border-b border-[var(--sf-hairline)] px-3 py-2 last:border-b-0">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--sf-text-1)]"
                checked={granted.includes(row.name)}
                disabled={!onChange}
                onChange={(e) => onChange?.(toggleTool(granted, row.name, e.target.checked))}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`${MONO} text-[13px] text-[var(--sf-text-1)]`}>
                  {row.name}
                  {row.missing ? <span className="ml-2 font-sans text-[11px] text-[var(--sf-needs)]">no longer on the server</span> : null}
                </span>
                {row.description ? <span className="line-clamp-2 text-xs text-[var(--sf-text-3)]">{row.description}</span> : null}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
