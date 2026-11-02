import { useState, type ReactNode } from "react";
import { identityApi, type IdentityConnection } from "../../api/identity";
import { IdentityDrawer } from "./identityOverlay";
import {
  CopyButton,
  DANGER,
  EYEBROW,
  Field,
  GHOST,
  INPUT,
  IdentityConnectionFacts,
  IdentityError,
  MONO,
  OidcDraftActions,
  SECONDARY,
  StatusLabel,
  Tag,
} from "./identityParts";
import { KIND_INFO, SECRET_WRITE_ONLY_COPY, connectionKind, connectionStatus, validClientSecret } from "./identityView";

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className={EYEBROW}>{title}</h3>
      {children}
    </section>
  );
}

const HANDOFF_CLAIMS: Array<[string, string]> = [
  ["iss, aud", "Match the issuer and audience registered here"],
  ["sub", "A stable user id that you map to an account under People & access"],
  ["workspace, agent", "This Host's Workspace and the agent above"],
  ["exp, jti", "Expires within 5 minutes; each token works once"],
];

export function ConnectionDrawer({
  connection,
  busy,
  error,
  recordedTest,
  run,
  onRecordedTest,
  onClose,
}: {
  connection: IdentityConnection;
  busy: boolean;
  error: string | null;
  recordedTest: boolean;
  run: (work: () => Promise<unknown>) => void;
  onRecordedTest: () => void;
  onClose: () => void;
}) {
  const kind = connectionKind(connection.kind);
  const status = connectionStatus(connection);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateSecret, setRotateSecret] = useState("");
  const [revocationUrl, setRevocationUrl] = useState("");
  const tested = recordedTest || connection.tested;
  const prepared = connection.status === "validated" || connection.status === "active" || connection.active;

  return (
    <IdentityDrawer
      title={connection.id}
      eyebrow={KIND_INFO[kind].title}
      titleAddon={<StatusLabel tone={status.tone} label={status.label} detail={status.detail} />}
      onClose={onClose}
    >
      {error ? <IdentityError code={error} /> : null}

      {kind === "oidc" ? (
        <DrawerSection title={connection.active ? "Sign-in" : "Go live"}>
          {connection.active ? (
            <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
              This connection is live. People can sign in with {connection.issuer || "the provider"} and reach the agent.
            </p>
          ) : (
            <OidcDraftActions
              recordedTest={tested}
              prepared={prepared}
              live={connection.active}
              busy={busy}
              onPrepare={() => run(() => identityApi.prepareOidc(connection.id))}
              onRecordTest={() => run(async () => {
                await identityApi.recordOidcTest(connection.id);
                onRecordedTest();
              })}
              onActivate={() => run(() => identityApi.activateOidc(connection.id))}
            />
          )}
        </DrawerSection>
      ) : null}

      {kind === "oidc" && connection.callbackPath ? (
        <DrawerSection title="Register this callback at your provider">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[#ffffff12] bg-[#0c0d0f] px-3 py-2">
            <code className={`min-w-0 break-all text-xs text-[#ecedee] ${MONO}`}>{connection.callbackPath}</code>
            <CopyButton value={connection.callbackPath} />
          </div>
          <p className="text-xs leading-[1.5] text-[#8b8f98]">
            Add your public address in front of this path. The provider must allow exactly that URL.
          </p>
        </DrawerSection>
      ) : null}

      {kind === "handoff" ? (
        <DrawerSection title="What your app must send">
          <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
            After your app signs someone in, it signs a one-time token and posts it to the agent&apos;s admission endpoint.
          </p>
          <dl className="flex flex-col gap-2 rounded-lg border border-[#ffffff12] bg-[#0c0d0f] p-3">
            {HANDOFF_CLAIMS.map(([claim, rule]) => (
              <div key={claim} className="flex items-baseline justify-between gap-3">
                <dt className={`shrink-0 text-xs text-[#ecedee] ${MONO}`}>{claim}</dt>
                <dd className="text-right text-xs text-[#8b8f98]">{rule}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-1.5">
            {connection.agentId ? <Tag mono>agent {connection.agentId}</Tag> : null}
            {connection.audience ? <Tag mono>aud {connection.audience}</Tag> : null}
          </div>
        </DrawerSection>
      ) : null}

      <DrawerSection title="Details">
        <IdentityConnectionFacts connection={connection} />
      </DrawerSection>

      {kind === "oidc" ? (
        <DrawerSection title="Catch removals at the provider">
          <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{connection.upstreamNote}</p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const url = revocationUrl.trim();
              if (!url) return;
              run(async () => {
                await identityApi.setRevocationSource(connection.id, url);
                setRevocationUrl("");
              });
            }}
          >
            <Field label="Revocation URL" hint="Must be on the issuer's origin and answer { &quot;active&quot;: false } for removed people.">
              <input
                className={`${INPUT} ${MONO}`}
                value={revocationUrl}
                placeholder={`${connection.issuer || "https://login.example.com"}/revoked`}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setRevocationUrl(event.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <button type="submit" className={SECONDARY} disabled={busy || !revocationUrl.trim()}>Save source</button>
              {connection.upstreamRevocation === "connected" ? (
                <button type="button" className={GHOST} disabled={busy} onClick={() => run(() => identityApi.setRevocationSource(connection.id, null))}>
                  Remove source
                </button>
              ) : null}
            </div>
          </form>
        </DrawerSection>
      ) : null}

      {kind === "oidc" ? (
        <DrawerSection title="Client secret">
          {rotateOpen ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const secret = rotateSecret;
                run(async () => {
                  await identityApi.rotateOidc(connection.id, secret);
                  setRotateSecret("");
                  setRotateOpen(false);
                });
              }}
            >
              <Field
                label="New client secret"
                hint={SECRET_WRITE_ONLY_COPY}
                error={rotateSecret.length > 0 && !validClientSecret(rotateSecret) ? "Use 16 to 512 characters on a single line." : undefined}
              >
                <input type="password" className={INPUT} value={rotateSecret} autoComplete="new-password" onChange={(event) => setRotateSecret(event.target.value)} />
              </Field>
              <div className="flex gap-2">
                <button type="submit" className={SECONDARY} disabled={busy || !validClientSecret(rotateSecret)}>Rotate secret</button>
                <button type="button" className={GHOST} onClick={() => { setRotateOpen(false); setRotateSecret(""); }}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-[#a7aab2]">Stored on this Host and never shown.</span>
              <button type="button" className={SECONDARY} onClick={() => setRotateOpen(true)}>Rotate…</button>
            </div>
          )}
        </DrawerSection>
      ) : null}

      {connection.status !== "disabled" ? (
        <DrawerSection title="Disable">
          <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
            Stops new sign-ins from this connection. Access you have saved for people on it is kept.
          </p>
          {confirmDisable ? (
            <div className="flex items-center gap-2">
              <button type="button" className={DANGER} disabled={busy} onClick={() => run(async () => {
                await identityApi.disable(connection.id);
                setConfirmDisable(false);
              })}>
                Yes, disable {connection.id}
              </button>
              <button type="button" className={GHOST} onClick={() => setConfirmDisable(false)}>Keep it</button>
            </div>
          ) : (
            <div>
              <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirmDisable(true)}>
                Disable connection
              </button>
            </div>
          )}
        </DrawerSection>
      ) : null}
    </IdentityDrawer>
  );
}
