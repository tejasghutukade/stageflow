import { useMemo, useState } from "react";
import { LuBot, LuCheck, LuKeyRound, LuLink2, LuTriangleAlert } from "react-icons/lu";
import { IdentityApiError, identityApi, type ChannelProvider, type IdentityScope, type SigningAlgorithm } from "../../api/identity";
import { chatOrigin, useHostInfo } from "../../hostInfo";
import { IdentityDialog } from "./identityOverlay";
import { AgentChips, ScopePicker } from "./identityPickers";
import { Field, GHOST, INPUT, IdentityError, MONO, PRIMARY, TILE } from "./identityParts";
import {
  JWKS_WRITE_ONLY_COPY,
  KIND_INFO,
  SECRET_WRITE_ONLY_COPY,
  SIGNING_ALGORITHMS,
  defaultRedirectUri,
  inspectJwks,
  parsePublicJwks,
  splitResourceList,
  validClientSecret,
  validConnectionId,
  type AgentOption,
  type ConnectionKind,
} from "./identityView";

const KIND_ICON = { handoff: LuLink2, oidc: LuKeyRound, service: LuBot, channel: LuLink2 } as const;
const KINDS = ["handoff", "oidc", "service", "channel"] as const;
const CHANNEL_PROVIDERS: readonly ChannelProvider[] = ["imessage", "telegram", "agentmail", "email"];

function errorCode(err: unknown): string {
  return err instanceof IdentityApiError ? err.code : "request_failed";
}

function AlgorithmChips({ value, onChange }: { value: SigningAlgorithm[]; onChange: (next: SigningAlgorithm[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Signing algorithms">
      {SIGNING_ALGORITHMS.map((algorithm) => {
        const active = value.includes(algorithm);
        return (
          <button
            key={algorithm}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? value.filter((item) => item !== algorithm) : [...value, algorithm])}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] ${MONO} ${active ? "border-[#6ca6ff] bg-[#6ca6ff14] text-[#ecedee]" : "border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2] hover:bg-[#22252b]"}`}
          >
            {active ? <LuCheck className="block size-3 text-[#6ca6ff]" aria-hidden /> : null}
            {algorithm}
          </button>
        );
      })}
    </div>
  );
}

function KindPicker({ value, onChange }: { value: ConnectionKind; onChange: (kind: ConnectionKind) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="tablist" aria-label="Connection type">
      {KINDS.map((kind) => {
        const Icon = KIND_ICON[kind];
        const active = kind === value;
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(kind)}
            className={`flex flex-col items-start gap-2 rounded-lg border p-3 text-left ${active ? "border-[#6ca6ff] bg-[#6ca6ff14]" : "border-[#ffffff1a] bg-[#1a1c21] hover:border-[#ffffff33]"}`}
          >
            <span className={`${TILE} size-8 bg-[#131418]`}><Icon className="block size-4 text-[#a7aab2]" aria-hidden /></span>
            <span className="text-[13px] font-medium text-[#ecedee]">{KIND_INFO[kind].title}</span>
            <span className="text-xs leading-[1.45] text-[#8b8f98]">{KIND_INFO[kind].bestFor}</span>
          </button>
        );
      })}
    </div>
  );
}

function JwksStatus({ text }: { text: string }) {
  const check = inspectJwks(text);
  if (check.state === "empty") return <span className="text-xs text-[#8b8f98]">{JWKS_WRITE_ONLY_COPY}</span>;
  if (check.state === "ok") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-[#4cc38a]">
        <LuCheck className="block size-3" aria-hidden />
        {check.count} public {check.count === 1 ? "key" : "keys"} found. {JWKS_WRITE_ONLY_COPY}
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5 text-xs text-[#f2645a]">
      <LuTriangleAlert className="mt-0.5 block size-3 shrink-0" aria-hidden />
      {check.state === "private"
        ? "This contains private key material. Paste only the public keys; the Host refuses private keys."
        : "That is not valid JWKS JSON. Paste an object with a keys array."}
    </span>
  );
}

export function IdentityConnectDialog({
  initialKind,
  agents,
  workspaceId,
  existingIds,
  onClose,
  onCreated,
}: {
  initialKind: ConnectionKind;
  agents: readonly AgentOption[];
  workspaceId: string;
  existingIds: readonly string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const firstAgent = agents[0];
  const [kind, setKind] = useState<ConnectionKind>(initialKind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [agent, setAgent] = useState(firstAgent?.id ?? "");
  const [issuer, setIssuer] = useState("");
  const [audience, setAudience] = useState("");
  const [handoffAlgorithms, setHandoffAlgorithms] = useState<SigningAlgorithm[]>(["ES256"]);
  const [oidcAlgorithmChoice, setOidcAlgorithmChoice] = useState<SigningAlgorithm[]>(["RS256"]);
  const [jwks, setJwks] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirect, setRedirect] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [scope, setScope] = useState<IdentityScope>("assigned");
  const [resources, setResources] = useState("");
  const [channelConnectionId, setChannelConnectionId] = useState("");
  const [provider, setProvider] = useState<ChannelProvider>("imessage");
  const [unmappedReply, setUnmappedReply] = useState("");

  const hostInfo = useHostInfo();
  const agentOption = agents.find((entry) => entry.id === agent);
  const suggestedRedirect = useMemo(
    () => defaultRedirectUri(chatOrigin(hostInfo, typeof window === "undefined" ? "" : window.location.origin), agentOption?.webChatUrl),
    [agentOption, hostInfo],
  );
  const redirectUri = redirect ?? suggestedRedirect;
  const idTaken = existingIds.includes(id.trim());
  const idInvalid = id.trim().length > 0 && !validConnectionId(id.trim());
  const chosenAlgorithms = SIGNING_ALGORITHMS.filter((algorithm) => handoffAlgorithms.includes(algorithm));
  const oidcAlgorithms = SIGNING_ALGORITHMS.filter((algorithm) => oidcAlgorithmChoice.includes(algorithm));
  const picked = splitResourceList(resources);
  const jwksOk = inspectJwks(jwks).state === "ok";

  const ready = (() => {
    if (!validConnectionId(id.trim()) || idTaken) return false;
    if (kind === "handoff") return Boolean(agent.trim() && issuer.trim() && audience.trim() && chosenAlgorithms.length > 0 && jwksOk);
    if (kind === "oidc") {
      return Boolean(agent.trim() && issuer.trim() && clientId.trim() && redirectUri.trim() && oidcAlgorithms.length > 0 && validClientSecret(clientSecret));
    }
    if (kind === "channel") {
      return Boolean(
        agent.trim() &&
          channelConnectionId.trim() &&
          unmappedReply.trim() &&
          (scope !== "selected" || picked.length > 0),
      );
    }
    return Boolean(agent.trim() && accountId.trim() && (scope !== "selected" || picked.length > 0));
  })();

  async function submit() {
    setError(null);
    const publicJwks = kind === "handoff" ? parsePublicJwks(jwks) : null;
    if (kind === "handoff" && !publicJwks) {
      setError("invalid_jwks");
      return;
    }
    setBusy(true);
    try {
      const connectionId = id.trim();
      if (kind === "handoff") {
        await identityApi.registerHandoff({
          id: connectionId,
          issuer: issuer.trim(),
          agentId: agent.trim(),
          audience: audience.trim(),
          algorithms: chosenAlgorithms,
          publicJwks: publicJwks!,
        });
      } else if (kind === "oidc") {
        await identityApi.registerOidc({
          id: connectionId,
          issuer: issuer.trim(),
          clientId: clientId.trim(),
          agentId: agent.trim(),
          clientSecret,
          redirectUri: redirectUri.trim(),
          algorithms: oidcAlgorithms,
        });
      } else if (kind === "channel") {
        await identityApi.registerChannel({
          id: connectionId,
          channelConnectionId: channelConnectionId.trim(),
          agentId: agent.trim(),
          provider,
          unmappedReply: unmappedReply.trim(),
          scope,
          agents: [agent.trim()],
          resources: scope === "selected" ? picked : [],
        });
      } else {
        await identityApi.registerService({
          id: connectionId,
          accountId: accountId.trim(),
          scope,
          agents: [agent.trim()],
          resources: scope === "selected" ? picked : [],
        });
      }
      setClientSecret("");
      setJwks("");
      onCreated(connectionId);
    } catch (err) {
      setError(errorCode(err));
      setBusy(false);
    }
  }

  const info = KIND_INFO[kind];
  const submitLabel =
    kind === "oidc" ? "Register draft" : kind === "service" ? "Create service identity" : kind === "channel" ? "Register channel" : "Register handoff";

  return (
    <IdentityDialog
      title="Add a connection"
      subtitle="Choose how people prove who they are. You can add more than one."
      titleId="identity-connect-title"
      busy={busy}
      width={680}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="text-xs text-[#8b8f98]">Workspace <span className={MONO}>{workspaceId || "—"}</span></span>
          <div className="flex items-center gap-2">
            <button type="button" className={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={PRIMARY} disabled={busy || !ready}>{busy ? "Registering…" : submitLabel}</button>
          </div>
        </>
      }
    >
      <KindPicker value={kind} onChange={(next) => { setKind(next); setError(null); }} />
      <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{info.blurb}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Connection id"
          hint="Letters, numbers, - and _. Shown in audit entries."
          error={idTaken ? "A connection with this id already exists." : idInvalid ? "Use letters, numbers, - and _ only." : undefined}
        >
          <input
            className={`${INPUT} ${MONO}`}
            value={id}
            placeholder={kind === "service" ? "nightly-report" : kind === "channel" ? "sms-support" : "shop-app"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setId(event.target.value)}
          />
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium leading-normal text-[#ecedee]">{kind === "service" ? "Agent it runs" : "Agent customers talk to"}</span>
          <AgentChips agents={agents} selected={agent ? [agent] : []} multiple={false} onChange={(next) => setAgent(next[0] ?? "")} />
          <span className="text-xs leading-[1.4] text-[#8b8f98]">Protected agents use web chat with authenticated access.</span>
        </div>
      </div>

      {kind === "handoff" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Issuer" hint="The name your app puts in the token's iss claim.">
              <input className={`${INPUT} ${MONO}`} value={issuer} placeholder="https://shop.example.com" autoComplete="off" spellCheck={false} onChange={(event) => setIssuer(event.target.value)} />
            </Field>
            <Field label="Audience" hint="The aud claim, exactly as your app signs it.">
              <input className={`${INPUT} ${MONO}`} value={audience} placeholder="stageflow:support" autoComplete="off" spellCheck={false} onChange={(event) => setAudience(event.target.value)} />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#ecedee]">Signing algorithms</span>
            <AlgorithmChips value={handoffAlgorithms} onChange={setHandoffAlgorithms} />
          </div>
          <Field label="Public keys (JWKS)">
            <textarea
              className={`${INPUT} min-h-32 py-2 text-xs leading-[1.6] ${MONO}`}
              value={jwks}
              placeholder={'{ "keys": [ { "kty": "EC", "crv": "P-256", "kid": "app-key", "x": "…", "y": "…" } ] }'}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setJwks(event.target.value)}
            />
            <JwksStatus text={jwks} />
          </Field>
        </>
      ) : null}

      {kind === "oidc" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Issuer URL" hint="Your provider's HTTPS issuer, e.g. an Okta or Entra tenant.">
              <input className={`${INPUT} ${MONO}`} value={issuer} placeholder="https://login.example.com" autoComplete="off" spellCheck={false} onChange={(event) => setIssuer(event.target.value)} />
            </Field>
            <Field label="Client id">
              <input className={`${INPUT} ${MONO}`} value={clientId} autoComplete="off" spellCheck={false} onChange={(event) => setClientId(event.target.value)} />
            </Field>
          </div>
          <Field
            label="Client secret"
            hint={SECRET_WRITE_ONLY_COPY}
            error={clientSecret.length > 0 && !validClientSecret(clientSecret) ? "Use 16 to 512 characters on a single line." : undefined}
          >
            <input type="password" className={INPUT} value={clientSecret} autoComplete="new-password" onChange={(event) => setClientSecret(event.target.value)} />
          </Field>
          <Field label="Redirect URI" hint="Add this exact URL to your provider's allowed callbacks.">
            <input className={`${INPUT} ${MONO}`} value={redirectUri} placeholder="https://chat.example.com/api/public/chat/support/oidc/callback" autoComplete="off" spellCheck={false} onChange={(event) => setRedirect(event.target.value)} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#ecedee]">ID token signing algorithms</span>
            <AlgorithmChips value={oidcAlgorithmChoice} onChange={setOidcAlgorithmChoice} />
            <span className="text-xs text-[#8b8f98]">Most providers sign with RS256.</span>
          </div>
        </>
      ) : null}

      {kind === "service" ? (
        <>
          <Field label="Business account" hint="The account this identity acts as in your order system.">
            <input className={`${INPUT} ${MONO}`} value={accountId} placeholder="acct_reports" autoComplete="off" spellCheck={false} onChange={(event) => setAccountId(event.target.value)} />
          </Field>
          <ScopePicker name="service-scope" value={scope} onChange={setScope} resources={resources} onResources={setResources} />
        </>
      ) : null}

      {kind === "channel" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Communications connection" hint="The connection id from Connections for this line or inbox.">
              <input
                className={`${INPUT} ${MONO}`}
                value={channelConnectionId}
                placeholder="alerts-imessage"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setChannelConnectionId(event.target.value)}
              />
            </Field>
            <Field label="Provider" hint="Must match the communications connection provider.">
              <select className={INPUT} value={provider} onChange={(event) => setProvider(event.target.value as ChannelProvider)}>
                {CHANNEL_PROVIDERS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <ScopePicker name="channel-scope" value={scope} onChange={setScope} resources={resources} onResources={setResources} />
          <Field label="Unmatched sender reply" hint="Fixed text when the sender is not mapped to an account. The agent does not respond.">
            <textarea
              className={`${INPUT} min-h-20 py-2 text-[13px] leading-[1.5]`}
              value={unmappedReply}
              placeholder="We could not match your message to an account."
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUnmappedReply(event.target.value)}
            />
          </Field>
        </>
      ) : null}

      {error ? <IdentityError code={error} /> : null}
    </IdentityDialog>
  );
}
