import { useState, type ReactNode } from "react";
import { LuCheck, LuTriangleAlert } from "react-icons/lu";
import {
  IdentityApiError,
  identityApi,
  type EngineTestResult,
  type IdentitySetupStatus,
  type OrdersTestResult,
} from "../../api/identity";
import {
  CARD,
  CopyButton,
  DANGER,
  EYEBROW,
  Field,
  GHOST,
  INPUT,
  IdentityError,
  MONO,
  PRIMARY,
  SECONDARY,
  Tag,
} from "./identityParts";
import {
  ORDER_API_CONTRACT,
  cerbosEndpointProblem,
  endpointProblem,
  engineTestCopy,
  ordersTestCopy,
  type Tone,
} from "./identityView";

function Card({ title, subtitle, aside, children }: { title: string; subtitle: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[15px] font-semibold text-[#ecedee]">{title}</h3>
          <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{subtitle}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Result({ tone, title, hint }: { tone: Tone; title: string; hint: string }) {
  const good = tone === "ok";
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] ${good ? "border-[#4cc38a47] bg-[#4cc38a14] text-[#4cc38a]" : tone === "needs" ? "border-[#f5b54447] bg-[#f5b5441a] text-[#f5b544]" : "border-[#f2645a47] bg-[#f2645a14] text-[#f2645a]"}`}
      role={good ? "status" : "alert"}
    >
      {good ? <LuCheck className="mt-0.5 block size-3.5 shrink-0" aria-hidden /> : <LuTriangleAlert className="mt-0.5 block size-3.5 shrink-0" aria-hidden />}
      <div className="flex flex-col gap-0.5">
        <span>{title}</span>
        <span className="text-xs text-[#a7aab2]">{hint}</span>
      </div>
    </div>
  );
}

function errorCode(err: unknown): string {
  return err instanceof IdentityApiError ? err.code : "request_failed";
}

function EngineCard({ setup, busy, run }: { setup: IdentitySetupStatus; busy: boolean; run: (work: () => Promise<unknown>) => void }) {
  const [kind, setKind] = useState<"scope" | "cerbos">(setup.engine.kind);
  const [endpoint, setEndpoint] = useState(setup.engine.kind === "cerbos" ? setup.engine.endpoint : "http://127.0.0.1:3592");
  const [test, setTest] = useState<EngineTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const problem = kind === "cerbos" ? cerbosEndpointProblem(endpoint) : null;
  const dirty = kind !== setup.engine.kind || (kind === "cerbos" && setup.engine.kind === "cerbos" && endpoint.trim() !== setup.engine.endpoint);
  const options: Array<{ id: "scope" | "cerbos"; title: string; body: string }> = [
    { id: "scope", title: "Built-in rules", body: "Checks the access level against the order's owner and assignments. Nothing else to run." },
    { id: "cerbos", title: "Cerbos policy server", body: "Adds your own policy on top. It can only narrow access, never widen it. Runs on this machine." },
  ];

  async function runTest() {
    setTesting(true);
    setTestError(null);
    setTest(null);
    try {
      setTest(await identityApi.testEngine());
    } catch (err) {
      setTestError(errorCode(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card title="Policy engine" subtitle="Who decides, order by order, whether a person may read it." aside={<Tag tone="ok">{setup.engine.kind === "scope" ? "Built-in" : "Cerbos"}</Tag>}>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Policy engine">
        {options.map((option) => (
          <label
            key={option.id}
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 ${kind === option.id ? "border-[#6ca6ff] bg-[#6ca6ff14]" : "border-[#ffffff1a] bg-[#1a1c21] hover:border-[#ffffff33]"}`}
          >
            <input type="radio" name="identity-engine" className="sr-only" checked={kind === option.id} onChange={() => { setKind(option.id); setTest(null); }} />
            <span className="text-[13px] font-medium text-[#ecedee]">{option.title}</span>
            <span className="text-xs leading-[1.45] text-[#a7aab2]">{option.body}</span>
          </label>
        ))}
      </div>
      {kind === "cerbos" ? (
        <Field label="Policy server address" hint="Load policy-samples/consumer-orders.yaml (version consumer_v1) into it first." error={problem}>
          <input className={`${INPUT} ${MONO}`} value={endpoint} autoComplete="off" spellCheck={false} onChange={(event) => { setEndpoint(event.target.value); setTest(null); }} />
        </Field>
      ) : null}
      {test ? <Result {...engineTestCopy(test)} /> : null}
      {testError ? <IdentityError code={testError} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={busy || !dirty || Boolean(problem) || (kind === "cerbos" && !endpoint.trim())}
          onClick={() => run(() => identityApi.setEngine(kind === "cerbos" ? { kind, endpoint: endpoint.trim() } : { kind }))}
        >
          Save engine
        </button>
        <button type="button" className={SECONDARY} disabled={busy || testing || dirty} onClick={() => void runTest()}>
          {testing ? "Testing…" : "Test engine"}
        </button>
        {dirty ? <span className="text-xs text-[#8b8f98]">Save before testing.</span> : null}
      </div>
    </Card>
  );
}

function SigningKey({ setup, busy, run }: { setup: IdentitySetupStatus; busy: boolean; run: (work: () => Promise<unknown>) => void }) {
  const [confirm, setConfirm] = useState(false);
  const key = setup.orders.signingKey;
  if (!key) return null;
  const jwk = JSON.stringify({ keys: [key.publicJwk] }, null, 2);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-[#ecedee]">Signing key <span className={`text-xs text-[#8b8f98] ${MONO}`}>{key.keyId}</span></span>
        <CopyButton value={jwk} label="Copy public key" />
      </div>
      <pre className={`max-h-40 overflow-auto rounded-lg border border-[#ffffff12] bg-[#0c0d0f] p-3 text-xs leading-[1.6] text-[#ecedee] ${MONO}`}>{jwk}</pre>
      <p className="text-xs leading-[1.5] text-[#8b8f98]">
        Stageflow signs each order read with the private half, which never leaves this Host. Your API verifies it with this public key (ES256).
      </p>
      {confirm ? (
        <div className="flex items-center gap-2">
          <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirm(false); run(() => identityApi.rotateSigningKey()); }}>Rotate now</button>
          <button type="button" className={GHOST} onClick={() => setConfirm(false)}>Keep this key</button>
          <span className="text-xs text-[#8b8f98]">Your API must trust the new key first, or reads will fail.</span>
        </div>
      ) : (
        <div><button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirm(true)}>Rotate key…</button></div>
      )}
    </div>
  );
}

function OrdersCard({ setup, busy, run }: { setup: IdentitySetupStatus; busy: boolean; run: (work: () => Promise<unknown>) => void }) {
  const configured = setup.orders.configured;
  const [editing, setEditing] = useState(!configured);
  const [endpoint, setEndpoint] = useState(setup.orders.endpoint);
  const [audience, setAudience] = useState(setup.orders.audience);
  const [credential, setCredential] = useState("");
  const [orderId, setOrderId] = useState("");
  const [test, setTest] = useState<OrdersTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const problem = endpointProblem(endpoint, setup.allowLoopback);
  const needsCredential = !setup.orders.hasCredential;
  const ready = Boolean(endpoint.trim() && audience.trim() && !problem && (!needsCredential || credential.length > 0));

  async function runTest() {
    setTesting(true);
    setTestError(null);
    setTest(null);
    try {
      setTest(await identityApi.testOrders(orderId.trim()));
    } catch (err) {
      setTestError(errorCode(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card
      title="Order API"
      subtitle="Where Stageflow checks who owns an order and reads its status. Without it, people can sign in but no private order is ever read."
      aside={<Tag tone={configured ? "ok" : "muted"}>{configured ? "Connected" : "Optional"}</Tag>}
    >
      {configured && !editing ? (
        <div className="flex flex-col gap-4">
          <dl className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3"><dt className="text-xs text-[#8b8f98]">Address</dt><dd className={`text-[13px] text-[#ecedee] ${MONO}`}>{setup.orders.endpoint}</dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt className="text-xs text-[#8b8f98]">Audience</dt><dd className={`text-[13px] text-[#ecedee] ${MONO}`}>{setup.orders.audience}</dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt className="text-xs text-[#8b8f98]">Credential</dt><dd className="text-[13px] text-[#ecedee]">{setup.orders.hasCredential ? "Saved, never shown" : "Missing"}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY} disabled={busy} onClick={() => { setEditing(true); setEndpoint(setup.orders.endpoint); setAudience(setup.orders.audience); }}>Edit settings…</button>
            {confirmRemove ? (
              <>
                <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirmRemove(false); run(() => identityApi.clearOrders()); }}>Remove order API</button>
                <button type="button" className={GHOST} onClick={() => setConfirmRemove(false)}>Keep it</button>
              </>
            ) : (
              <button type="button" className={GHOST} disabled={busy} onClick={() => setConfirmRemove(true)}>Remove…</button>
            )}
          </div>
          <SigningKey setup={setup} busy={busy} run={run} />
          <div className="flex flex-col gap-2 border-t border-t-[#ffffff12] pt-4">
            <span className="text-[13px] font-medium text-[#ecedee]">Test your order API</span>
            <p className="text-xs leading-[1.5] text-[#8b8f98]">Asks for the ownership of one real order. Only ownership details come back; the order&apos;s contents are not read.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${INPUT} max-w-[240px] ${MONO}`} aria-label="Order id to test" value={orderId} placeholder="ord_1001" autoComplete="off" spellCheck={false} onChange={(event) => setOrderId(event.target.value)} />
              <button type="button" className={SECONDARY} disabled={busy || testing || !orderId.trim()} onClick={() => void runTest()}>{testing ? "Testing…" : "Run test"}</button>
            </div>
            {test ? <Result {...ordersTestCopy(test)} /> : null}
            {testError ? <IdentityError code={testError} /> : null}
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const secret = credential;
            run(async () => {
              await identityApi.saveOrders({ endpoint: endpoint.trim(), audience: audience.trim(), ...(secret ? { credential: secret } : {}) });
              setCredential("");
              setEditing(false);
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" hint="Your order API's base address." error={problem}>
              <input className={`${INPUT} ${MONO}`} value={endpoint} placeholder="https://orders.example.com" autoComplete="off" spellCheck={false} onChange={(event) => setEndpoint(event.target.value)} />
            </Field>
            <Field label="Audience" hint="Stageflow puts this in the aud claim it signs.">
              <input className={`${INPUT} ${MONO}`} value={audience} placeholder="orders-api" autoComplete="off" spellCheck={false} onChange={(event) => setAudience(event.target.value)} />
            </Field>
          </div>
          <Field label="API credential" hint={setup.orders.hasCredential ? "Leave empty to keep the saved credential." : "Sent as a bearer token. Stored on this Host and never shown again. Not a login token."}>
            <input type="password" className={INPUT} value={credential} autoComplete="new-password" onChange={(event) => setCredential(event.target.value)} />
          </Field>
          <div className="flex gap-2">
            <button type="submit" className={PRIMARY} disabled={busy || !ready}>{configured ? "Save changes" : "Connect order API"}</button>
            {configured ? <button type="button" className={GHOST} onClick={() => { setEditing(false); setCredential(""); }}>Cancel</button> : null}
          </div>
        </form>
      )}
      <details className="rounded-lg border border-[#ffffff12] bg-[#0c0d0f]">
        <summary className="cursor-pointer px-3 py-2 text-[13px] text-[#a7aab2]">What your API must implement</summary>
        <div className="flex flex-col gap-3 border-t border-t-[#ffffff12] px-3 py-3">
          {ORDER_API_CONTRACT.map((entry) => (
            <div key={entry.path} className="flex flex-col gap-1">
              <span className={`text-xs text-[#ecedee] ${MONO}`}>{entry.path}</span>
              <span className="text-xs text-[#8b8f98]">Receives {entry.sends}.</span>
              <span className="text-xs text-[#8b8f98]">Returns {entry.returns}.</span>
            </div>
          ))}
          <p className="text-xs leading-[1.5] text-[#8b8f98]">
            Verify the signed token, its audience, expiry (30 seconds at most), the resource and its own ownership before returning anything private. A mismatch must deny.
          </p>
        </div>
      </details>
    </Card>
  );
}

export function SetupPanel({
  setup,
  busy,
  error,
  run,
}: {
  setup: IdentitySetupStatus;
  busy: boolean;
  error: string | null;
  run: (work: () => Promise<unknown>) => void;
}) {
  const [confirmOff, setConfirmOff] = useState(false);
  if (setup.mode === "embedded") {
    return (
      <div className={`${CARD} flex flex-col gap-1 p-5`}>
        <h3 className="text-[15px] font-semibold text-[#ecedee]">Managed by the app that runs this Host</h3>
        <p className="text-[13px] leading-[1.5] text-[#a7aab2]">The policy engine and order API are set in code there, so they cannot be changed from the console.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {error ? <IdentityError code={error} /> : null}
      <EngineCard key={`${setup.engine.kind}:${setup.engine.kind === "cerbos" ? setup.engine.endpoint : ""}`} setup={setup} busy={busy} run={run} />
      <OrdersCard key={`${setup.orders.configured}:${setup.orders.endpoint}:${setup.orders.audience}`} setup={setup} busy={busy} run={run} />
      <section className={`${CARD} flex flex-col gap-3 p-5`}>
        <span className={EYEBROW}>Turn off</span>
        <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
          Protected agent chats stop working until you turn identity back on. People, access and activity are kept.
        </p>
        {confirmOff ? (
          <div className="flex items-center gap-2">
            <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirmOff(false); run(() => identityApi.disableIdentity()); }}>Yes, turn off identity</button>
            <button type="button" className={GHOST} onClick={() => setConfirmOff(false)}>Keep it on</button>
          </div>
        ) : (
          <div><button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirmOff(true)}>Turn off identity…</button></div>
        )}
      </section>
    </div>
  );
}
