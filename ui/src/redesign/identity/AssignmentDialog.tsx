import { useState } from "react";
import { IdentityApiError, identityApi, type IdentityAssignment, type IdentityConnection, type IdentityScope } from "../../api/identity";
import { IdentityDialog } from "./identityOverlay";
import { AgentChips, ScopePicker } from "./identityPickers";
import { Field, GHOST, INPUT, IdentityError, MONO, PRIMARY, Tag } from "./identityParts";
import { KIND_INFO, connectionKind, matchingAssignment, splitResourceList, type AgentOption } from "./identityView";

export function AssignmentDialog({
  connections,
  assignments,
  agents,
  editing,
  onClose,
  onSaved,
}: {
  connections: readonly IdentityConnection[];
  assignments: readonly IdentityAssignment[];
  agents: readonly AgentOption[];
  editing: IdentityAssignment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const usable = connections.filter((row) => row.kind !== "service" && (row.active || row.id === editing?.connectionId));
  const [connectionId, setConnectionId] = useState(editing?.connectionId ?? usable[0]?.id ?? "");
  const [subject, setSubject] = useState(editing?.subject ?? "");
  const [accountId, setAccountId] = useState(editing?.accountId ?? "");
  const [scope, setScope] = useState<IdentityScope>(editing?.scope ?? "own");
  const [resources, setResources] = useState(editing?.resources.join(", ") ?? "");
  const connection = usable.find((row) => row.id === connectionId);
  const [pickedAgents, setPickedAgents] = useState<string[]>(
    editing?.agents.length ? editing.agents : connection?.agentId ? [connection.agentId] : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = editing ?? matchingAssignment(assignments, connectionId, subject);
  const listed = splitResourceList(resources);
  const ready = Boolean(
    connectionId && subject.trim() && accountId.trim() && pickedAgents.length > 0 && (scope !== "selected" || listed.length > 0),
  );

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await identityApi.saveAssignment({
        connectionId,
        subject: subject.trim(),
        accountId: accountId.trim(),
        scope,
        resources: scope === "selected" ? listed : [],
        agents: pickedAgents,
        ...(existing ? { expectedRevision: existing.revision } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof IdentityApiError ? err.code : "request_failed");
      setBusy(false);
    }
  }

  return (
    <IdentityDialog
      title={editing ? (editing.active ? "Edit access" : "Restore access") : "Give someone access"}
      subtitle="Map a sign-in to a business account, then choose what that account may see."
      titleId="identity-assign-title"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="text-xs text-[#8b8f98]">
            {existing ? `Saving makes revision ${existing.revision + 1} and ends their open chats.` : "Takes effect on their next message."}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" className={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={PRIMARY} disabled={busy || !ready}>{busy ? "Saving…" : editing ? "Save access" : "Grant access"}</button>
          </div>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sign-in connection" hint={connection ? KIND_INFO[connectionKind(connection.kind)].title : "Only live connections can be mapped."}>
          <select
            className={INPUT}
            value={connectionId}
            disabled={Boolean(editing)}
            onChange={(event) => {
              const next = usable.find((row) => row.id === event.target.value);
              setConnectionId(event.target.value);
              if (next?.agentId) setPickedAgents([next.agentId]);
            }}
          >
            {usable.length === 0 ? <option value="">No live connections</option> : null}
            {usable.map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}
          </select>
        </Field>
        <Field label="Person (subject)" hint="The stable user id your sign-in sends as sub. Not an email address.">
          <input
            className={`${INPUT} ${MONO}`}
            value={subject}
            disabled={Boolean(editing)}
            placeholder="user_8f2c1"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Business account" hint="The account id this person acts as in your order system. Stageflow never guesses it from an email or a group name.">
        <input
          className={`${INPUT} ${MONO}`}
          value={accountId}
          placeholder="acct_1001"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setAccountId(event.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-[#ecedee]">Agents they can use</span>
        <AgentChips agents={agents} selected={pickedAgents} onChange={setPickedAgents} />
      </div>
      <ScopePicker name="assignment-scope" value={scope} onChange={setScope} resources={resources} onResources={setResources} />
      {existing && !editing ? (
        <div className="flex items-center gap-2 text-xs text-[#a7aab2]">
          <Tag tone="needs">Existing</Tag>
          This person already has access. Saving replaces it.
        </div>
      ) : null}
      {error ? <IdentityError code={error} /> : null}
    </IdentityDialog>
  );
}
