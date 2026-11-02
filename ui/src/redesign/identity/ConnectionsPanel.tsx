import { LuBot, LuChevronRight, LuKeyRound, LuLink2, LuPlug } from "react-icons/lu";
import type { IdentityConnection } from "../../api/identity";
import { CARD, EYEBROW, EmptyState, MONO, StatusLabel, TILE, Tag } from "./identityParts";
import { KIND_INFO, connectionKind, connectionStatus, type ConnectionKind } from "./identityView";

const KIND_ICON = { handoff: LuLink2, oidc: LuKeyRound, service: LuBot } as const;
const GRID = "grid grid-cols-[minmax(0,1fr)_200px_150px_20px] items-center gap-4";
const KINDS: readonly ConnectionKind[] = ["handoff", "oidc", "service"];

export function ConnectionsPanel({
  connections,
  loading,
  onOpen,
  onAdd,
}: {
  connections: readonly IdentityConnection[];
  loading: boolean;
  onOpen: (id: string) => void;
  onAdd: (kind: ConnectionKind) => void;
}) {
  if (connections.length === 0) {
    if (loading) return <p className="text-[13px] text-[#8b8f98]">Loading connections…</p>;
    return (
      <div className="flex flex-col gap-4">
        <EmptyState icon={<LuPlug className="block size-4 text-[#a7aab2]" aria-hidden />} title="No sign-in connected yet">
          <p>
            A connection is how Stageflow learns who is talking to an agent. Pick the one that matches how your
            customers and employees already log in.
          </p>
        </EmptyState>
        <div className="grid gap-3 md:grid-cols-3">
          {KINDS.map((kind) => {
            const Icon = KIND_ICON[kind];
            return (
              <button
                key={kind}
                type="button"
                onClick={() => onAdd(kind)}
                className={`${CARD} flex flex-col items-start gap-3 p-4 text-left hover:border-[#ffffff33]`}
              >
                <span className={TILE}><Icon className="block size-4 text-[#a7aab2]" aria-hidden /></span>
                <span className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium text-[#ecedee]">{KIND_INFO[kind].title}</span>
                  <span className="text-xs leading-[1.5] text-[#8b8f98]">{KIND_INFO[kind].blurb}</span>
                </span>
                <span className="mt-auto text-xs font-medium text-[#6ca6ff]">Set up →</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className={`${GRID} px-4 py-2.5`}>
        <span className={EYEBROW}>Connection</span>
        <span className={EYEBROW}>Status</span>
        <span className={EYEBROW}>Removals</span>
        <span />
      </div>
      {connections.map((connection) => {
        const kind = connectionKind(connection.kind);
        const Icon = KIND_ICON[kind];
        const status = connectionStatus(connection);
        return (
          <button
            key={connection.id}
            type="button"
            onClick={() => onOpen(connection.id)}
            aria-label={`Open ${connection.id}`}
            className={`${GRID} w-full border-t border-t-[#ffffff12] px-4 py-3 text-left hover:bg-[#16171b]`}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className={TILE}><Icon className="block size-4 text-[#a7aab2]" aria-hidden /></span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-[13px] font-medium text-[#ecedee] ${MONO}`}>{connection.id}</span>
                  <Tag>{KIND_INFO[kind].label}</Tag>
                </span>
                <span className={`truncate text-xs text-[#8b8f98] ${connection.issuer ? MONO : ""}`}>
                  {connection.issuer || (connection.agentId ? `agent ${connection.agentId}` : "Unattended runs")}
                </span>
              </span>
            </span>
            <StatusLabel tone={status.tone} label={status.label} detail={status.detail} />
            <span className="text-xs text-[#a7aab2]">
              {kind === "oidc" || kind === "handoff"
                ? connection.upstreamRevocation === "connected" ? "Checked at provider" : "Local only"
                : "—"}
            </span>
            <LuChevronRight className="block size-4 text-[#8b8f98]" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
