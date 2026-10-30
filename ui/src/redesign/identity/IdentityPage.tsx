import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "../shell/PageHeader";
import {
  IdentityApiError,
  identityApi,
  type IdentityAssignment,
  type IdentityAuditEvent,
  type IdentityConnection,
  type IdentityScope,
  type SigningAlgorithm,
} from "../../api/identity";
import {
  IDENTITY_SCOPES,
  JWKS_WRITE_ONLY_COPY,
  SECRET_WRITE_ONLY_COPY,
  matchingAssignment,
  splitResourceList,
} from "./identityView";
import {
  CARD,
  EYEBROW,
  INPUT,
  IdentityAuditTable,
  IdentityConnectionFacts,
  IdentityError,
  IdentityPreviewNotice,
  IdentityPreviewResult,
  OidcDraftActions,
  PRIMARY,
  SECONDARY,
} from "./identityParts";

const ALGORITHMS: readonly SigningAlgorithm[] = ["RS256", "ES256", "EdDSA"];
const MONO = "[font-family:'Geist_Mono',_monospace]";

function errorCode(err: unknown): string {
  return err instanceof IdentityApiError ? err.code : "request_failed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePublicJwks(text: string): { keys: Record<string, unknown>[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || !parsed.every(isPlainObject)) return null;
    return { keys: parsed };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0 || !parsed.keys.every(isPlainObject)) {
    return null;
  }
  return { keys: parsed.keys };
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5${className ? ` ${className}` : ""}`}>
      <span className="text-xs text-[#8b8f98]">{label}</span>
      {children}
    </label>
  );
}

export function IdentityPage() {
  const mounted = useRef(true);
  const holdSelection = useRef<string | null>(null);
  const [connections, setConnections] = useState<IdentityConnection[]>([]);
  const [assignments, setAssignments] = useState<IdentityAssignment[]>([]);
  const [audit, setAudit] = useState<IdentityAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tested, setTested] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [oidcError, setOidcError] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<"allow" | "deny" | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [handoff, setHandoff] = useState({ id: "", issuer: "", agentId: "", audience: "", jwks: "" });
  const [algorithms, setAlgorithms] = useState<SigningAlgorithm[]>(["ES256"]);
  const [oidc, setOidc] = useState({ id: "", issuer: "", clientId: "", agentId: "", clientSecret: "" });
  const [rotateSecret, setRotateSecret] = useState("");
  const [assignment, setAssignment] = useState({
    connectionId: "",
    subject: "",
    accountId: "",
    scope: "own" as IdentityScope,
    resources: "",
  });
  const [sample, setSample] = useState({ orderId: "", owner: "", version: "" });

  const reload = useCallback(async () => {
    const [connectionResult, assignmentResult, auditResult] = await Promise.allSettled([
      identityApi.connections(),
      identityApi.assignments(),
      identityApi.audit(50),
    ]);
    if (!mounted.current) return;
    if (connectionResult.status === "fulfilled") {
      const rows = connectionResult.value;
      setConnections(rows);
      const prefer = holdSelection.current;
      holdSelection.current = null;
      setSelectedId((current) => {
        const preferred = prefer ?? current;
        if (preferred && rows.some((row) => row.id === preferred)) return preferred;
        return rows[0]?.id ?? null;
      });
    }
    if (assignmentResult.status === "fulfilled") setAssignments(assignmentResult.value);
    if (auditResult.status === "fulfilled") setAudit(auditResult.value);
    const failed = [connectionResult, assignmentResult, auditResult].find((result) => result.status === "rejected");
    setLoadError(failed && failed.status === "rejected" ? errorCode(failed.reason) : null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload().finally(() => {
      if (mounted.current) setLoading(false);
    });
  }, [reload]);

  const selected = connections.find((row) => row.id === selectedId) ?? null;
  const assignmentConnectionId = assignment.connectionId;
  const loaded = matchingAssignment(assignments, assignmentConnectionId, assignment.subject);
  const shownRevision = savedRevision ?? loaded?.revision ?? null;
  const resources = splitResourceList(assignment.resources);

  async function act(setError: (value: string | null) => void, work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      if (mounted.current) setError(errorCode(err));
    }
    try {
      await reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const handoffReady = Boolean(handoff.id.trim() && handoff.issuer.trim() && handoff.agentId.trim() && handoff.audience.trim() && handoff.jwks.trim() && algorithms.length > 0);
  const oidcReady = Boolean(oidc.id.trim() && oidc.issuer.trim() && oidc.clientId.trim() && oidc.agentId.trim() && oidc.clientSecret);
  const assignmentReady = Boolean(assignmentConnectionId && assignment.subject.trim() && assignment.accountId.trim() && (assignment.scope !== "selected" || resources.length > 0));
  const previewReady = Boolean(sample.orderId.trim() && sample.owner.trim() && sample.version.trim() && assignmentConnectionId && assignment.subject.trim() && assignment.accountId.trim());

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PageHeader
          title="Identity"
          description="Sign-in connections, account assignments, and the authorization audit."
        />
        <div className="flex flex-col gap-6 px-7 py-7">
          {loading ? <p className="text-[13px] text-[#8b8f98]">Loading…</p> : null}
          {loadError ? <IdentityError code={loadError} /> : null}

          <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Connections">
            <h2 className={EYEBROW}>Connections</h2>
            {connectionError ? <IdentityError code={connectionError} /> : null}
            {connections.length === 0 ? (
              loading ? null : <p className="text-[13px] text-[#a7aab2]">No identity connections yet.</p>
            ) : (
              <table className="w-full border-collapse text-left text-[13px] text-[#ecedee]">
                <thead>
                  <tr className="text-xs text-[#8b8f98]">
                    <th className="px-2 py-2 font-medium">Id</th>
                    <th className="px-2 py-2 font-medium">Kind</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Active</th>
                    <th className="px-2 py-2 font-medium">Upstream revocation</th>
                    <th className="px-2 py-2 font-medium">Upstream note</th>
                    <th className="px-2 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {connections.map((connection) => (
                    <tr key={connection.id} className={`border-t border-[#ffffff12] ${connection.id === selectedId ? "bg-[#1a1c21]" : ""}`}>
                      <td className="px-2 py-2">
                        <button type="button" className={`text-[#6ca6ff] underline ${MONO}`} onClick={() => setSelectedId(connection.id)}>
                          {connection.id}
                        </button>
                      </td>
                      <td className="px-2 py-2">{connection.kind}</td>
                      <td className="px-2 py-2">{connection.status}</td>
                      <td className="px-2 py-2">{connection.active ? "Active" : "Inactive"}</td>
                      <td className="px-2 py-2">{connection.upstreamRevocation}</td>
                      <td className="whitespace-pre-wrap px-2 py-2">
                        {connection.upstreamRevocation === "local_only" ? connection.upstreamNote : ""}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          className={SECONDARY}
                          disabled={busy || !connection.active}
                          onClick={() => {
                            setSelectedId(connection.id);
                            void act(setConnectionError, () => identityApi.disable(connection.id).then(() => undefined));
                          }}
                        >
                          Disable
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Handoff">
            <h2 className={EYEBROW}>Handoff</h2>
            <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{JWKS_WRITE_ONLY_COPY}</p>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const publicJwks = parsePublicJwks(handoff.jwks);
                if (!publicJwks) {
                  setHandoffError("invalid_jwks");
                  return;
                }
                const chosen = ALGORITHMS.filter((algorithm) => algorithms.includes(algorithm));
                void act(setHandoffError, async () => {
                  const created = await identityApi.registerHandoff({
                    id: handoff.id.trim(),
                    issuer: handoff.issuer.trim(),
                    agentId: handoff.agentId.trim(),
                    audience: handoff.audience.trim(),
                    algorithms: chosen,
                    publicJwks,
                  });
                  holdSelection.current = created.id;
                  setHandoff((current) => ({ ...current, jwks: "" }));
                });
              }}
            >
              <Field label="Connection id">
                <input className={`${INPUT} ${MONO}`} value={handoff.id} autoComplete="off" onChange={(event) => setHandoff((current) => ({ ...current, id: event.target.value }))} />
              </Field>
              <Field label="Agent">
                <input className={`${INPUT} ${MONO}`} value={handoff.agentId} autoComplete="off" onChange={(event) => setHandoff((current) => ({ ...current, agentId: event.target.value }))} />
              </Field>
              <Field label="Issuer">
                <input className={`${INPUT} ${MONO}`} value={handoff.issuer} autoComplete="off" onChange={(event) => setHandoff((current) => ({ ...current, issuer: event.target.value }))} />
              </Field>
              <Field label="Audience">
                <input className={`${INPUT} ${MONO}`} value={handoff.audience} autoComplete="off" onChange={(event) => setHandoff((current) => ({ ...current, audience: event.target.value }))} />
              </Field>
              <fieldset className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <legend className="text-xs text-[#8b8f98]">Algorithms</legend>
                {ALGORITHMS.map((algorithm) => (
                  <label key={algorithm} className={`flex items-center gap-1.5 text-[13px] text-[#ecedee] ${MONO}`}>
                    <input
                      type="checkbox"
                      checked={algorithms.includes(algorithm)}
                      onChange={() => {
                        setAlgorithms((current) => (
                          current.includes(algorithm) ? current.filter((item) => item !== algorithm) : [...current, algorithm]
                        ));
                      }}
                    />
                    {algorithm}
                  </label>
                ))}
              </fieldset>
              <Field label="Public JWKS" className="sm:col-span-2">
                <textarea
                  className={`${INPUT} min-h-28 py-2 ${MONO}`}
                  value={handoff.jwks}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setHandoff((current) => ({ ...current, jwks: event.target.value }))}
                />
              </Field>
              {handoffError ? <IdentityError code={handoffError} /> : null}
              <div>
                <button type="submit" className={PRIMARY} disabled={busy || !handoffReady}>
                  Register
                </button>
              </div>
            </form>
          </section>

          <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="OIDC">
            <h2 className={EYEBROW}>OIDC</h2>
            <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{SECRET_WRITE_ONLY_COPY}</p>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const secret = oidc.clientSecret;
                void act(setOidcError, async () => {
                  const created = await identityApi.registerOidc({
                    id: oidc.id.trim(),
                    issuer: oidc.issuer.trim(),
                    clientId: oidc.clientId.trim(),
                    agentId: oidc.agentId.trim(),
                    clientSecret: secret,
                  });
                  holdSelection.current = created.id;
                  setOidc((current) => ({ ...current, clientSecret: "" }));
                });
              }}
            >
              <Field label="Connection id">
                <input className={`${INPUT} ${MONO}`} value={oidc.id} autoComplete="off" onChange={(event) => setOidc((current) => ({ ...current, id: event.target.value }))} />
              </Field>
              <Field label="Agent">
                <input className={`${INPUT} ${MONO}`} value={oidc.agentId} autoComplete="off" onChange={(event) => setOidc((current) => ({ ...current, agentId: event.target.value }))} />
              </Field>
              <Field label="Issuer">
                <input className={`${INPUT} ${MONO}`} value={oidc.issuer} autoComplete="off" onChange={(event) => setOidc((current) => ({ ...current, issuer: event.target.value }))} />
              </Field>
              <Field label="Client id">
                <input className={`${INPUT} ${MONO}`} value={oidc.clientId} autoComplete="off" onChange={(event) => setOidc((current) => ({ ...current, clientId: event.target.value }))} />
              </Field>
              <Field label="Client secret">
                <input
                  type="password"
                  className={INPUT}
                  value={oidc.clientSecret}
                  autoComplete="new-password"
                  onChange={(event) => setOidc((current) => ({ ...current, clientSecret: event.target.value }))}
                />
              </Field>
              {oidcError ? <IdentityError code={oidcError} /> : null}
              <div className="sm:col-span-2">
                <button type="submit" className={PRIMARY} disabled={busy || !oidcReady}>
                  Register draft
                </button>
              </div>
            </form>
            {selected ? (
              <div className="flex flex-col gap-3 border-t border-[#ffffff12] pt-3">
                <h3 className={`${MONO} text-[13px] text-[#ecedee]`}>{selected.id}</h3>
                <IdentityConnectionFacts connection={selected} />
                {selected.kind === "oidc" ? (
                  <>
                    <OidcDraftActions
                      recordedTest={tested.has(selected.id)}
                      busy={busy}
                      onPrepare={() => {
                        void act(setOidcError, () => identityApi.prepareOidc(selected.id).then(() => undefined));
                      }}
                      onRecordTest={() => {
                        void act(setOidcError, async () => {
                          await identityApi.recordOidcTest(selected.id);
                          setTested((current) => new Set(current).add(selected.id));
                        });
                      }}
                      onActivate={() => {
                        void act(setOidcError, () => identityApi.activateOidc(selected.id).then(() => undefined));
                      }}
                    />
                    <form
                      className="flex flex-col gap-2 sm:max-w-sm"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const secret = rotateSecret;
                        void act(setOidcError, async () => {
                          await identityApi.rotateOidc(selected.id, secret);
                          setRotateSecret("");
                        });
                      }}
                    >
                      <Field label="New client secret">
                        <input
                          type="password"
                          className={INPUT}
                          value={rotateSecret}
                          autoComplete="new-password"
                          onChange={(event) => setRotateSecret(event.target.value)}
                        />
                      </Field>
                      <button type="submit" className={SECONDARY} disabled={busy || rotateSecret.length === 0}>
                        Rotate secret
                      </button>
                    </form>
                  </>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Assignment">
            <h2 className={EYEBROW}>Assignment</h2>
            {!loading && assignments.length === 0 ? (
              <p className="text-[13px] text-[#a7aab2]">No assignments yet.</p>
            ) : null}
            {assignments.length > 0 ? (
              <table className="w-full border-collapse text-left text-[13px] text-[#ecedee]">
                <thead>
                  <tr className="text-xs text-[#8b8f98]">
                    <th className="px-2 py-2 font-medium">Subject</th>
                    <th className="px-2 py-2 font-medium">Account</th>
                    <th className="px-2 py-2 font-medium">Scope</th>
                    <th className="px-2 py-2 font-medium">Resources</th>
                    <th className="px-2 py-2 font-medium">Revision</th>
                    <th className="px-2 py-2 font-medium">Active</th>
                    <th className="px-2 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((row) => (
                    <tr key={row.id} className="border-t border-[#ffffff12]">
                      <td className={`px-2 py-2 ${MONO}`}>{row.subject}</td>
                      <td className={`px-2 py-2 ${MONO}`}>{row.accountId}</td>
                      <td className="px-2 py-2">{row.scope}</td>
                      <td className={`px-2 py-2 ${MONO}`}>{row.resources.join(", ")}</td>
                      <td className="px-2 py-2">{row.revision}</td>
                      <td className="px-2 py-2">{row.active ? "Active" : "Inactive"}</td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          className={SECONDARY}
                          disabled={busy || !row.active}
                          onClick={() => {
                            void act(setAssignmentError, () => identityApi.revokeAssignment(row.id));
                          }}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const expected = matchingAssignment(assignments, assignmentConnectionId, assignment.subject);
                void act(setAssignmentError, async () => {
                  try {
                    const saved = await identityApi.saveAssignment({
                      connectionId: assignmentConnectionId,
                      subject: assignment.subject.trim(),
                      accountId: assignment.accountId.trim(),
                      scope: assignment.scope,
                      resources: assignment.scope === "selected" ? resources : [],
                      ...(expected ? { expectedRevision: expected.revision } : {}),
                    });
                    setSavedRevision(saved.revision);
                  } catch (err) {
                    setSavedRevision(null);
                    throw err;
                  }
                });
              }}
            >
              <Field label="Connection">
                <select
                  className={INPUT}
                  value={assignmentConnectionId}
                  onChange={(event) => {
                    setSavedRevision(null);
                    setAssignment((current) => ({ ...current, connectionId: event.target.value }));
                  }}
                >
                  <option value="">Select a connection</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Subject">
                <input
                  className={`${INPUT} ${MONO}`}
                  value={assignment.subject}
                  autoComplete="off"
                  onChange={(event) => {
                    setSavedRevision(null);
                    setAssignment((current) => ({ ...current, subject: event.target.value }));
                  }}
                />
              </Field>
              <Field label="Account">
                <input
                  className={`${INPUT} ${MONO}`}
                  value={assignment.accountId}
                  autoComplete="off"
                  onChange={(event) => setAssignment((current) => ({ ...current, accountId: event.target.value }))}
                />
              </Field>
              <Field label="Scope">
                <select
                  className={INPUT}
                  value={assignment.scope}
                  onChange={(event) => setAssignment((current) => ({ ...current, scope: event.target.value as IdentityScope }))}
                >
                  {IDENTITY_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
              </Field>
              {assignment.scope === "selected" ? (
                <Field label="Resources" className="sm:col-span-2">
                  <input
                    className={`${INPUT} ${MONO}`}
                    value={assignment.resources}
                    autoComplete="off"
                    onChange={(event) => setAssignment((current) => ({ ...current, resources: event.target.value }))}
                  />
                </Field>
              ) : null}
              {shownRevision !== null ? (
                <p className="text-[13px] text-[#ecedee]" data-testid="identity-revision">
                  Revision {shownRevision}
                </p>
              ) : null}
              {assignmentError ? <IdentityError code={assignmentError} /> : null}
              <div className="sm:col-span-2">
                <button type="submit" className={PRIMARY} disabled={busy || !assignmentReady}>
                  Activate
                </button>
              </div>
            </form>
          </section>

          <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Preview">
            <h2 className={EYEBROW}>Preview</h2>
            <IdentityPreviewNotice />
            <p className="text-[13px] leading-[1.5] text-[#a7aab2]">It checks the assignment above against the sample order.</p>
            <form
              className="grid gap-3 sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                void act(setPreviewError, async () => {
                  setPreview(null);
                  const result = await identityApi.preview({
                    connectionId: assignmentConnectionId,
                    subject: assignment.subject.trim(),
                    accountId: assignment.accountId.trim(),
                    scope: assignment.scope,
                    resources: assignment.scope === "selected" ? resources : [],
                    orderId: sample.orderId.trim(),
                    owner: sample.owner.trim(),
                    version: sample.version.trim(),
                  });
                  setPreview(result.outcome);
                });
              }}
            >
              <Field label="Order id">
                <input className={`${INPUT} ${MONO}`} value={sample.orderId} autoComplete="off" onChange={(event) => setSample((current) => ({ ...current, orderId: event.target.value }))} />
              </Field>
              <Field label="Owner">
                <input className={`${INPUT} ${MONO}`} value={sample.owner} autoComplete="off" onChange={(event) => setSample((current) => ({ ...current, owner: event.target.value }))} />
              </Field>
              <Field label="Version">
                <input className={`${INPUT} ${MONO}`} value={sample.version} autoComplete="off" onChange={(event) => setSample((current) => ({ ...current, version: event.target.value }))} />
              </Field>
              {previewError ? <IdentityError code={previewError} /> : null}
              {preview ? <IdentityPreviewResult outcome={preview} /> : null}
              <div className="sm:col-span-3">
                <button type="submit" className={SECONDARY} disabled={busy || !previewReady}>
                  Preview
                </button>
              </div>
            </form>
          </section>

          <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Audit">
            <h2 className={EYEBROW}>Audit</h2>
            {!loading && audit.length === 0 ? <p className="text-[13px] text-[#a7aab2]">No audit events.</p> : null}
            {audit.length > 0 ? <IdentityAuditTable events={audit} /> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
