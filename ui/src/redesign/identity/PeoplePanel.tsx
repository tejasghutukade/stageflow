import { useState } from "react";
import { LuSearch, LuUsers } from "react-icons/lu";
import type { IdentityAssignment } from "../../api/identity";
import { CARD, DANGER, EYEBROW, EmptyState, GHOST, INPUT, MONO, PRIMARY, SECONDARY, StatusLabel, TILE, Tag } from "./identityParts";
import { SCOPE_INFO, initials } from "./identityView";

const GRID = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_110px_200px] items-center gap-4";

export function PeoplePanel({
  assignments,
  hasConnections,
  busy,
  onAdd,
  onEdit,
  onRevoke,
}: {
  assignments: readonly IdentityAssignment[];
  hasConnections: boolean;
  busy: boolean;
  onAdd: () => void;
  onEdit: (row: IdentityAssignment) => void;
  onRevoke: (row: IdentityAssignment) => void;
}) {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? assignments.filter((row) => [row.subject, row.accountId, row.connectionId].some((value) => value.toLowerCase().includes(needle)))
    : assignments;

  if (assignments.length === 0) {
    return (
      <EmptyState icon={<LuUsers className="block size-4 text-[#a7aab2]" aria-hidden />} title="Nobody has access yet">
        <p>
          Signing in proves who someone is. Here you decide what they may see: map each person&apos;s sign-in to a business
          account, then choose how much of it they can reach.
        </p>
        <button type="button" className={PRIMARY} onClick={onAdd} disabled={!hasConnections}>Give someone access</button>
        {!hasConnections ? <p className="text-xs text-[#8b8f98]">Add a connection first so there is a sign-in to map.</p> : null}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-[320px]">
          <LuSearch className="pointer-events-none absolute left-3 top-1/2 block size-3.5 -translate-y-1/2 text-[#8b8f98]" aria-hidden />
          <input
            className={`${INPUT} pl-9`}
            value={query}
            placeholder="Search by person, account or connection"
            aria-label="Search people"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button type="button" className={PRIMARY} onClick={onAdd} disabled={!hasConnections}>Give someone access</button>
      </div>
      <div className={`${CARD} overflow-hidden`}>
        <div className={`${GRID} px-4 py-2.5`}>
          <span className={EYEBROW}>Person</span>
          <span className={EYEBROW}>Acts as account</span>
          <span className={EYEBROW}>Can see</span>
          <span className={EYEBROW}>Status</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <p className="border-t border-t-[#ffffff12] px-4 py-6 text-center text-[13px] text-[#8b8f98]">No one matches “{query}”.</p>
        ) : null}
        {rows.map((row) => {
          const info = SCOPE_INFO[row.scope];
          const isService = row.subject.startsWith("service:");
          return (
            <div key={row.id} className={`${GRID} border-t border-t-[#ffffff12] px-4 py-3`}>
              <div className="flex min-w-0 items-center gap-3">
                <span className={`${TILE} rounded-full text-[11px] font-medium text-[#a7aab2] ${MONO}`}>{initials(row.subject.replace(/^service:/, ""))}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className={`truncate text-[13px] font-medium text-[#ecedee] ${MONO}`}>{row.subject}</span>
                  <span className="flex items-center gap-1.5 text-xs text-[#8b8f98]">
                    via <span className={MONO}>{row.connectionId}</span>
                    {isService ? <Tag>Service</Tag> : null}
                  </span>
                </div>
              </div>
              <span className={`truncate text-[13px] text-[#ecedee] ${MONO}`}>{row.accountId}</span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] text-[#ecedee]">
                  {info.label}
                  {info.broad ? <Tag tone="needs">Broad</Tag> : null}
                </span>
                <span className={`truncate text-xs text-[#8b8f98] ${row.scope === "selected" ? MONO : ""}`}>
                  {row.scope === "selected"
                    ? `${row.resources.length} ${row.resources.length === 1 ? "order" : "orders"}: ${row.resources.join(", ")}`
                    : row.agents.length > 0 ? `on ${row.agents.join(", ")}` : " "}
                </span>
              </div>
              <StatusLabel tone={row.active ? "ok" : "muted"} label={row.active ? "Active" : "Revoked"} detail={`Revision ${row.revision}`} />
              <div className="flex items-center justify-end gap-2">
                {confirming === row.id ? (
                  <>
                    <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirming(null); onRevoke(row); }}>Revoke</button>
                    <button type="button" className={GHOST} onClick={() => setConfirming(null)}>Keep</button>
                  </>
                ) : row.active ? (
                  <>
                    <button type="button" className={SECONDARY} disabled={busy} onClick={() => onEdit(row)}>Edit</button>
                    <button type="button" className={GHOST} disabled={busy} onClick={() => setConfirming(row.id)}>Revoke…</button>
                  </>
                ) : (
                  <button type="button" className={SECONDARY} disabled={busy} onClick={() => onEdit(row)}>Restore…</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
