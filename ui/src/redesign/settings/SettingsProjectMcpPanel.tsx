import { useEffect, useRef, useState } from "react";
import {
  fetchProjectMcp,
  postProjectMcpProbe,
} from "../../api";
import {
  PROJECT_MCP_SETTINGS_COPY,
  createProjectMcpSettingsSession,
  projectMcpDotToken,
  projectMcpSectionError,
  projectMcpStatusLabel,
  type ProjectMcpSettingsState,
} from "../../components/SettingsProjectMcp";
import { SettingsEyebrow } from "./SettingsSectionPanels";

export function SettingsProjectMcpPanel() {
  const sessionRef = useRef<ReturnType<
    typeof createProjectMcpSettingsSession
  > | null>(null);
  const [state, setState] = useState<ProjectMcpSettingsState>({
    loading: true,
    catalogStatus: null,
    servers: [],
    error: null,
  });

  useEffect(() => {
    const session = createProjectMcpSettingsSession({
      list: fetchProjectMcp,
      probe: postProjectMcpProbe,
    });
    sessionRef.current = session;
    setState(session.getState());
    const unsubscribe = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => {
      unsubscribe();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, []);

  const sectionError = state.catalogStatus
    ? projectMcpSectionError(state.catalogStatus)
    : null;

  return (
    <div className="flex flex-col gap-2.5">
      <SettingsEyebrow>Project MCP</SettingsEyebrow>
      <p className="font-sans text-[13px] text-[var(--sf-text-2)]">
        {PROJECT_MCP_SETTINGS_COPY}
      </p>
      {state.error ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{state.error}</p>
      ) : null}
      {sectionError ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{sectionError}</p>
      ) : null}
      <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
        {state.loading ? (
          <>
            <div className="flex h-14 items-center gap-3 border-b border-b-[#ffffff12] px-3.5">
              <div className="size-7 animate-pulse rounded-[7px] bg-[var(--sf-raised)]" />
              <div className="h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
            </div>
            <div className="flex h-14 items-center gap-3 px-3.5">
              <div className="size-7 animate-pulse rounded-[7px] bg-[var(--sf-raised)]" />
              <div className="h-3 w-28 animate-pulse rounded bg-[var(--sf-raised)]" />
            </div>
          </>
        ) : state.catalogStatus === "ok" && state.servers.length === 0 ? (
          <p className="px-3.5 py-6 font-sans text-[13px] text-[var(--sf-text-3)]">
            No servers in .mcp.json.
          </p>
        ) : (
          state.servers.map((row, index) => {
            const token = projectMcpDotToken(row.status);
            const probing = row.status === "probing";
            const last = index === state.servers.length - 1;
            return (
              <div
                key={row.name}
                className={`flex h-14 items-center gap-3 px-3.5${
                  last ? "" : " border-b border-b-[#ffffff12]"
                }`}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
                    {row.name}
                  </span>
                  <span className="font-sans text-xs text-[var(--sf-text-3)]">
                    {row.transport}
                    {row.error ? ` · ${row.error}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2.5">
                  <span className="flex items-center gap-1.5 font-sans text-xs text-[var(--sf-text-2)]">
                    {token ? (
                      <span
                        className={`size-1.5 rounded-full${
                          token === "running"
                            ? " bg-[var(--sf-running)]"
                            : token === "succeeded"
                              ? " bg-[var(--sf-ok)]"
                              : token === "waiting"
                                ? " bg-[var(--sf-needs)]"
                                : " bg-[var(--sf-fail)]"
                        }`}
                      />
                    ) : null}
                    {projectMcpStatusLabel(row.status)}
                  </span>
                  <button
                    type="button"
                    className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-60"
                    disabled={probing}
                    onClick={() => void sessionRef.current?.check(row.name)}
                  >
                    {probing ? "Checking…" : "Check"}
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
