import { useCallback, useEffect, useState } from "react";
import { LuArrowLeft, LuCheck, LuCopy, LuMinus, LuPlug, LuRefreshCw, LuTriangleAlert } from "react-icons/lu";
import { checkChannelConnection, fetchChannelConnections, type ChannelConnectionListing } from "../../api";
import { ageLabel, channelStatus, codeMessage } from "../../pages/channelStatus";
import { navigate } from "../../routes";
import { detailFacts, fixHint, providerInfo, usageSnippet } from "./connectionsModel";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const NOWRAP = "[white-space-collapse:collapse] [text-wrap-mode:nowrap]";
const EYEBROW = `text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase ${NOWRAP}`;
const CARD = "rounded-lg border border-[#ffffff12] bg-[#131418]";

function StatusPill({ connection }: { connection: ChannelConnectionListing }) {
  const status = channelStatus(connection);
  const tone = status.tone === "ok"
    ? "border-[#4cc38a40] bg-[#4cc38a14] text-[#4cc38a]"
    : status.tone === "needs"
      ? "border-[#f5b54447] bg-[#f5b54414] text-[#f5b544]"
      : "border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]";
  const Icon = status.tone === "ok" ? LuCheck : status.tone === "needs" ? LuTriangleAlert : LuMinus;
  return (
    <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${tone}`}>
      <Icon className="size-3 block" aria-hidden />
      {status.label}
    </span>
  );
}

export function ConnectionDetailPage({ connectionId }: { connectionId: string }) {
  const [connection, setConnection] = useState<ChannelConnectionListing | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void fetchChannelConnections().then(
      (result) => {
        if (cancelled) return;
        const found = result.connections.find((entry) => entry.id === connectionId);
        setConnection(found ?? null);
        setError(result.error ?? null);
        setState(found ? "ready" : result.error ? "error" : "missing");
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      },
    );
    return () => { cancelled = true; };
  }, [connectionId]);

  const check = useCallback(() => {
    setChecking(true);
    void checkChannelConnection(connectionId)
      .then((health) => { setConnection((current) => (current ? { ...current, health } : current)); setNow(Date.now()); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setChecking(false));
  }, [connectionId]);

  const back = () => navigate("/connections");
  const info = connection ? providerInfo(connection.provider) : undefined;
  const status = connection ? channelStatus(connection) : null;
  const hint = connection?.health?.state === "failed" ? fixHint(connection.health.error?.code) : undefined;
  const snippet = connection ? usageSnippet(connection.provider, connection.id) : "";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className="flex w-full shrink-0 items-start justify-between gap-4 border-b border-b-[#ffffff12] px-7 pb-5 pt-5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <button type="button" onClick={back} className="flex w-fit items-center gap-1.5 text-xs text-[#8b8f98] hover:text-[#ecedee]">
              <LuArrowLeft className="size-3 block" aria-hidden />
              Connections
              <span aria-hidden>/</span>
              <span className="text-[#a7aab2]">{info?.label ?? connectionId}</span>
            </button>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className={`truncate text-2xl font-semibold leading-normal tracking-[-0.48px] text-[#ecedee] ${MONO}`}>
                {connection?.identity ?? connectionId}
              </h1>
              {connection ? <StatusPill connection={connection} /> : null}
            </div>
            {connection ? (
              <p className="text-[13px] leading-normal text-[#a7aab2]">
                {info?.label ?? connection.provider} · Communication channel ·{" "}
                {connection.health ? `Last checked ${ageLabel(connection.health.checkedAt, now)}` : "Not checked yet"}
              </p>
            ) : null}
          </div>
          {connection?.enabled ? (
            <button
              type="button" onClick={check} disabled={checking}
              className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee] disabled:opacity-60"
            >
              <LuRefreshCw className={`size-3.5 block ${checking ? "animate-spin" : ""}`} aria-hidden />
              {checking ? "Checking" : "Test connection"}
            </button>
          ) : null}
        </header>

        {state === "loading" ? <div className="px-7 py-7 text-[13px] text-[#8b8f98]">Loading…</div> : null}
        {state === "missing" ? (
          <div className="px-7 py-7 text-[13px] text-[#a7aab2]">
            No connection named <span className={MONO}>{connectionId}</span> in connections.yaml.{" "}
            <button type="button" onClick={back} className="text-[#6ca6ff] underline">Back to Connections</button>
          </div>
        ) : null}
        {state === "error" ? (
          <div className="mx-7 mt-7 flex items-start gap-2 rounded-lg border border-[#f5b54447] bg-[#16140f] px-3 py-2.5 text-[13px] text-[#f5b544]" role="alert">
            <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Could not load this connection: {error ? codeMessage(error) : "unknown error"}
          </div>
        ) : null}

        {connection && status ? (
          <div className="grid grid-cols-1 gap-6 px-7 py-7 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-6">
              <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Status">
                <span className={EYEBROW}>Status</span>
                <div className="flex items-start gap-2">
                  <span className="text-[15px] font-semibold text-[#ecedee]">{status.label}</span>
                </div>
                {status.detail ? <p className="text-[13px] leading-normal text-[#a7aab2]">{status.detail}</p> : null}
                {hint ? <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{hint}</p> : null}
                {!connection.health ? (
                  <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
                    Stageflow has not checked this connection yet. The host checks every few minutes, or run a check now.
                  </p>
                ) : null}
                {connection.health?.state === "ok" ? (
                  <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
                    The provider accepted the credential. A passing check does not prove a message will be delivered to a particular recipient.
                  </p>
                ) : null}
                {!connection.enabled ? (
                  <p className="text-[13px] leading-[1.5] text-[#a7aab2]">This connection is disabled in connections.yaml, so stages cannot use it.</p>
                ) : null}
              </section>

              <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label="Use in a stage">
                <div className="flex items-center justify-between">
                  <span className={EYEBROW}>Use in a stage</span>
                  <button
                    type="button"
                    onClick={() => { void navigator.clipboard?.writeText(snippet).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => undefined); }}
                    className="flex h-7 items-center gap-1.5 rounded-md border border-[#ffffff1a] px-2 text-xs text-[#a7aab2] hover:bg-[#1a1c21]"
                  >
                    {copied ? <LuCheck className="size-3 block text-[#4cc38a]" aria-hidden /> : <LuCopy className="size-3 block" aria-hidden />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="text-[13px] leading-[1.5] text-[#a7aab2]">
                  A stage sends through this connection by declaring it under <span className={MONO}>channels:</span> with the recipient pinned. The agent gets a <span className={MONO}>send_message</span> tool and cannot choose another recipient.
                </p>
                <pre className={`overflow-x-auto rounded-lg border border-[#ffffff12] bg-[#0c0d0f] p-3 text-xs leading-[1.6] text-[#ecedee] ${MONO}`}>{snippet}</pre>
              </section>
            </div>

            <aside className="flex min-w-0 flex-col gap-6" aria-label="Details">
              <section className={`${CARD} flex flex-col gap-3 p-4`}>
                <span className={EYEBROW}>Connection</span>
                <dl className="flex flex-col gap-2.5">
                  {detailFacts(connection).map((fact) => (
                    <div key={fact.label} className="flex items-baseline justify-between gap-3">
                      <dt className="text-xs text-[#8b8f98]">{fact.label}</dt>
                      <dd className={`min-w-0 truncate text-[13px] text-[#ecedee] ${fact.mono ? MONO : ""}`} title={fact.value}>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section className={`${CARD} flex flex-col gap-2 p-4`}>
                <span className={EYEBROW}>Credential</span>
                <div className="flex items-center gap-2 text-[13px] text-[#ecedee]">
                  <LuPlug className="size-3.5 block text-[#8b8f98]" aria-hidden />
                  Read from the host environment
                </div>
                <p className="text-xs leading-[1.5] text-[#8b8f98]">
                  connections.yaml holds only <span className={MONO}>env:NAME</span> references. Secret values are never written to the file, shown here, or passed to a stage.
                </p>
              </section>
              <section className="flex flex-col gap-2 rounded-lg border border-[#f2645a40] p-4">
                <span className={EYEBROW}>Disconnect</span>
                <p className="text-xs leading-[1.5] text-[#a7aab2]">
                  Remove this entry from connections.yaml and restart Stageflow. Stages that still list it will fail validation. Nothing is deleted at {info?.label ?? "the provider"}.
                </p>
              </section>
            </aside>
          </div>
        ) : null}
      </div>
    </div>
  );
}
