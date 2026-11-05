import { a2aConfigFileLabel, type A2aCaller, type A2aPublication, type A2aStatus } from "../../api/a2a";
import { PageHeader } from "../shell/PageHeader";
import { FilterTabs } from "../shell/FilterTabs";
import { CARD, MONO, SECONDARY, SectionHead } from "../identity/identityParts";
import { AddressRow, A2aError, NewTokenNotice } from "./A2aParts";
import { A2aTurnOn } from "./A2aTurnOn";
import { CallersPanel } from "./CallersPanel";
import { PublicationsPanel } from "./PublicationsPanel";
import { StatusPanel } from "./StatusPanel";
import { failedReload, type A2aScreen as ScreenState } from "./a2aView";

export type A2aTabId = "callers" | "publications" | "status";

const TAB_COPY: Record<A2aTabId, { title: string; subtitle: string }> = {
  callers: { title: "Callers", subtitle: "The outside agents that may call this Host, each with its own token." },
  publications: { title: "Published pipelines", subtitle: "The pipelines other agents can call, and which callers may use each." },
  status: { title: "Status", subtitle: "Whether A2A is loaded, and what to give the calling agent." },
};

export type A2aScreenProps = {
  screen: ScreenState;
  status: A2aStatus | null;
  callers: readonly A2aCaller[];
  publications: readonly A2aPublication[];
  tab: A2aTabId;
  busy: boolean;
  now: number;
  loadError: string | null;
  actionError: { code: string; detail: string } | null;
  issued: { caller: string; token: string } | null;
  onTab: (tab: A2aTabId) => void;
  onRetry: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onReload: () => void;
  onAddCaller: (name: string) => void;
  onRevokeCaller: (id: string) => void;
  onPublicationSaved: () => void;
  onRemovePublication: (id: string) => void;
  onDismissToken: () => void;
};

export function A2aScreen(props: A2aScreenProps) {
  const { screen, status, tab } = props;
  const on = screen === "no_callers" || screen === "ready";
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PageHeader title="A2A" subtitle="Let other agents call the pipelines you publish" />

        {props.issued && !on ? (
          <div className="px-5 pt-6">
            <NewTokenNotice caller={props.issued.caller} token={props.issued.token} onDismiss={props.onDismissToken} />
          </div>
        ) : null}

        {screen === "loading" ? (
          <p className="px-5 py-7 text-[13px] text-[#8b8f98]" role="status">Loading…</p>
        ) : null}

        {screen === "error" ? (
          <div className="flex flex-col items-start gap-3 px-5 py-7">
            <A2aError code={props.loadError ?? "request_failed"} />
            <button type="button" className={SECONDARY} onClick={props.onRetry}>Retry</button>
          </div>
        ) : null}

        {screen === "off" && status ? (
          <div className="px-5 py-7">
            <A2aTurnOn
              kept={status.configPath !== ""}
              busy={props.busy}
              errorCode={props.actionError?.code ?? null}
              errorDetail={props.actionError?.detail}
              onEnable={props.onEnable}
            />
          </div>
        ) : null}

        {screen === "configuration_error" && status ? (
          <div className="flex flex-col items-start gap-3 px-5 py-7" data-testid="a2a-configuration-error">
            <div className="flex w-full max-w-[720px] flex-col gap-3">
              <SectionHead title="A2A has a configuration error" subtitle="Other agents get an unavailable answer until the configuration loads again." />
              <div className="flex flex-col gap-1 rounded-lg border border-[#f2645a47] bg-[#f2645a14] px-4 py-3" role="alert">
                <span className={`break-words text-[13px] text-[#f2645a] ${MONO}`}>{status.error?.message ?? "The configuration could not be loaded."}</span>
                {status.configPath ? <span className={`break-all text-xs text-[#a7aab2] ${MONO}`}>{a2aConfigFileLabel(status)}</span> : null}
              </div>
              {props.actionError ? <A2aError code={props.actionError.code} detail={props.actionError.detail} /> : null}
              <div>
                <button type="button" className={SECONDARY} disabled={props.busy} onClick={props.onReload}>Reload configuration</button>
              </div>
            </div>
          </div>
        ) : null}

        {on && status ? (
          <>
            <FilterTabs
              activeId={tab}
              onChange={(id) => props.onTab(id as A2aTabId)}
              tabs={[
                { id: "callers", label: "Callers", count: props.callers.length },
                { id: "publications", label: "Published pipelines", count: props.publications.length },
                { id: "status", label: "Status" },
              ]}
            />
            <div className="flex flex-col gap-6 px-5 py-6">
              {props.issued ? <NewTokenNotice caller={props.issued.caller} token={props.issued.token} onDismiss={props.onDismissToken} /> : null}
              {failedReload(status) ? (
                <div className="flex flex-col items-start gap-2 rounded-lg border border-[#f5b54447] bg-[#f5b5441a] px-4 py-3" role="alert" data-testid="a2a-reload-failed">
                  <span className="text-[13px] font-medium text-[#ecedee]">The last reload failed. The previous configuration is still in use.</span>
                  <span className={`break-words text-xs text-[#f5b544] ${MONO}`}>{failedReload(status)!.message}</span>
                  <button type="button" className={SECONDARY} disabled={props.busy} onClick={props.onReload}>Reload configuration</button>
                </div>
              ) : null}
              <div className={`${CARD} divide-y divide-[#ffffff12]`}>
                <AddressRow label="Public address" value={status.publicUrl} />
                <AddressRow label="Agent card address" value={status.agentCardUrl} />
              </div>
              <SectionHead title={TAB_COPY[tab].title} subtitle={TAB_COPY[tab].subtitle} />
              {props.actionError ? <A2aError code={props.actionError.code} detail={props.actionError.detail} /> : null}
              {tab === "callers" ? (
                <CallersPanel
                  callers={props.callers}
                  publications={props.publications}
                  busy={props.busy}
                  onAdd={props.onAddCaller}
                  onRevoke={props.onRevokeCaller}
                />
              ) : null}
              {tab === "publications" ? (
                <PublicationsPanel
                  publications={props.publications}
                  callers={props.callers}
                  busy={props.busy}
                  onSaved={props.onPublicationSaved}
                  onRemove={props.onRemovePublication}
                />
              ) : null}
              {tab === "status" ? (
                <StatusPanel status={status} busy={props.busy} now={props.now} onReload={props.onReload} onDisable={props.onDisable} />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
