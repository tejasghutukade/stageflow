import { useState } from "react";
import { LuFlaskConical } from "react-icons/lu";
import { IdentityApiError, identityApi, type IdentityAssignment } from "../../api/identity";
import { CARD, EmptyState, Field, GHOST, INPUT, IdentityError, IdentityPreviewNotice, IdentityPreviewResult, MONO, SECONDARY, Tag } from "./identityParts";
import { SCOPE_INFO, splitResourceList } from "./identityView";

export function CheckAccessPanel({ assignments, workspaceId }: { assignments: readonly IdentityAssignment[]; workspaceId: string }) {
  const active = assignments.filter((row) => row.active);
  const [personId, setPersonId] = useState(active[0]?.id ?? "");
  const [order, setOrder] = useState({ id: "", owner: "", assigned: "", version: "1" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"allow" | "deny" | null>(null);

  const person = active.find((row) => row.id === personId) ?? active[0];

  if (active.length === 0) {
    return (
      <EmptyState icon={<LuFlaskConical className="block size-4 text-[#a7aab2]" aria-hidden />} title="Nobody to check yet">
        <p>Give someone access first. Then come back to test what they could read before a real customer does.</p>
      </EmptyState>
    );
  }

  const ready = Boolean(person && order.id.trim() && order.owner.trim() && order.version.trim() && workspaceId);

  async function run() {
    if (!person) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const outcome = await identityApi.preview({
        accountId: person.accountId,
        scope: person.scope,
        resources: person.scope === "selected" ? person.resources : [],
        order: {
          id: order.id.trim(),
          workspaceId,
          ownerAccountId: order.owner.trim(),
          assignedAccountIds: splitResourceList(order.assigned),
          version: order.version.trim(),
        },
      });
      setResult(outcome.outcome);
    } catch (err) {
      setError(err instanceof IdentityApiError ? err.code : "request_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form
        className={`${CARD} flex flex-col gap-4 p-5`}
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold text-[#ecedee]">Can this person read this order?</h3>
          <IdentityPreviewNotice />
          <p className="text-[13px] leading-[1.5] text-[#a7aab2]">Nothing is saved and no order data is fetched. Only the ownership details below are checked.</p>
        </div>
        <Field label="Person">
          <select className={INPUT} value={person?.id ?? ""} onChange={(event) => { setPersonId(event.target.value); setResult(null); }}>
            {active.map((row) => (
              <option key={row.id} value={row.id}>{row.subject} → {row.accountId}</option>
            ))}
          </select>
        </Field>
        {person ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8b8f98]">
            <Tag>{SCOPE_INFO[person.scope].label}</Tag>
            <span>{SCOPE_INFO[person.scope].summary}</span>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Order id">
            <input className={`${INPUT} ${MONO}`} value={order.id} placeholder="ord_1001" autoComplete="off" spellCheck={false} onChange={(event) => setOrder((current) => ({ ...current, id: event.target.value }))} />
          </Field>
          <Field label="Version" hint="Ownership version of the order.">
            <input className={`${INPUT} ${MONO}`} value={order.version} autoComplete="off" spellCheck={false} onChange={(event) => setOrder((current) => ({ ...current, version: event.target.value }))} />
          </Field>
          <Field label="Owner account">
            <input className={`${INPUT} ${MONO}`} value={order.owner} placeholder="acct_1001" autoComplete="off" spellCheck={false} onChange={(event) => setOrder((current) => ({ ...current, owner: event.target.value }))} />
          </Field>
          <Field label="Assigned accounts" hint="Optional. Support staff on this order.">
            <input className={`${INPUT} ${MONO}`} value={order.assigned} placeholder="acct_support_1" autoComplete="off" spellCheck={false} onChange={(event) => setOrder((current) => ({ ...current, assigned: event.target.value }))} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#8b8f98]">Fill in:</span>
          <button
            type="button"
            className={GHOST}
            disabled={!person}
            onClick={() => { setOrder((current) => ({ ...current, id: current.id || "ord_sample", owner: person?.accountId ?? "" })); setResult(null); }}
          >
            An order they own
          </button>
          <button
            type="button"
            className={GHOST}
            disabled={!person}
            onClick={() => { setOrder((current) => ({ ...current, id: current.id || "ord_sample", owner: "acct_someone_else", assigned: "" })); setResult(null); }}
          >
            Someone else&apos;s order
          </button>
        </div>
        {error ? <IdentityError code={error} /> : null}
        <div>
          <button type="submit" className={SECONDARY} disabled={busy || !ready}>{busy ? "Checking…" : "Preview"}</button>
        </div>
      </form>
      <div className="flex flex-col gap-3">
        {result ? (
          <IdentityPreviewResult outcome={result} />
        ) : (
          <div className={`${CARD} flex flex-col gap-2 p-5 text-[13px] leading-[1.5] text-[#a7aab2]`}>
            <span className="font-medium text-[#ecedee]">How the check works</span>
            <p>Stageflow asks the same policy engine it uses in real chats. A person is allowed only when their access level and the order&apos;s ownership agree.</p>
            <p className="text-[#8b8f98]">The engine can narrow an answer, but it can never grant an order the access level refuses.</p>
          </div>
        )}
      </div>
    </div>
  );
}
