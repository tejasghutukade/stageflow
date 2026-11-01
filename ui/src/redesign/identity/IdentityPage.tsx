import { useCallback, useEffect, useRef, useState } from "react";
import { LuCheck, LuPlus } from "react-icons/lu";
import { PageHeader } from "../shell/PageHeader";
import { FilterTabs } from "../shell/FilterTabs";
import { agentsApi } from "../../api/agents";
import {
  IdentityApiError,
  identityApi,
  type IdentityAssignment,
  type IdentityAuditEvent,
  type IdentityConnection,
  type IdentitySetupStatus,
} from "../../api/identity";
import { ActivityPanel } from "./ActivityPanel";
import { AssignmentDialog } from "./AssignmentDialog";
import { CheckAccessPanel } from "./CheckAccessPanel";
import { ConnectionDrawer } from "./ConnectionDrawer";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { IdentityConnectDialog } from "./IdentityConnectDialog";
import { PeoplePanel } from "./PeoplePanel";
import { SetupPanel } from "./SetupPanel";
import { SetupRequired } from "./SetupRequired";
import { IdentityError, MONO, PRIMARY, SectionHead } from "./identityParts";
import { isSetupRequired, readinessSteps, type AgentOption, type ConnectionKind } from "./identityView";

type TabId = "connections" | "people" | "check" | "activity" | "setup";

const TAB_COPY: Record<TabId, { title: string; subtitle: string }> = {
  connections: {
    title: "Sign-in connections",
    subtitle: "How people prove who they are before they talk to an agent.",
  },
  people: {
    title: "People & access",
    subtitle: "Which sign-in maps to which business account, and what that account may see.",
  },
  check: {
    title: "Check access",
    subtitle: "Try a person against an order before a real customer does.",
  },
  activity: {
    title: "Activity",
    subtitle: "Who signed in, what they read, and what was refused.",
  },
  setup: {
    title: "Setup",
    subtitle: "The policy engine, your order API, and the signing key your API verifies.",
  },
};

function errorCode(err: unknown): string {
  return err instanceof IdentityApiError ? err.code : "request_failed";
}

function Readiness({ steps, onPick }: { steps: ReturnType<typeof readinessSteps>; onPick: (tab: TabId) => void }) {
  const target: TabId[] = ["connections", "people", "check"];
  const currentIndex = steps.findIndex((step) => !step.done);
  return (
    <ol className="grid gap-px overflow-hidden rounded-lg border border-[#ffffff12] bg-[#ffffff12] md:grid-cols-3" aria-label="Setup progress">
      {steps.map((step, index) => {
        const current = index === currentIndex;
        return (
          <li key={step.id} className="bg-[#131418]">
            <button
              type="button"
              onClick={() => onPick(target[index]!)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#16171b]"
            >
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${MONO} ${step.done ? "border-transparent bg-[#4cc38a1f] text-[#4cc38a]" : current ? "border-[#6ca6ff] text-[#6ca6ff]" : "border-[#ffffff1a] text-[#8b8f98]"}`}
              >
                {step.done ? <LuCheck className="block size-3.5" aria-hidden /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={`text-[13px] font-medium ${step.done || current ? "text-[#ecedee]" : "text-[#a7aab2]"}`}>{step.label}</span>
                <span className="truncate text-xs text-[#8b8f98]">{step.detail}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function IdentityPage() {
  const mounted = useRef(true);
  const [connections, setConnections] = useState<IdentityConnection[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [assignments, setAssignments] = useState<IdentityAssignment[]>([]);
  const [audit, setAudit] = useState<IdentityAuditEvent[]>([]);
  const [setup, setSetup] = useState<IdentitySetupStatus | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("connections");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [connectKind, setConnectKind] = useState<ConnectionKind | null>(null);
  const [assigning, setAssigning] = useState<{ editing: IdentityAssignment | null } | null>(null);
  const [tested, setTested] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const [overviewResult, assignmentResult, auditResult, setupResult] = await Promise.allSettled([
      identityApi.overview(),
      identityApi.assignments(),
      identityApi.audit(50),
      identityApi.setup(),
    ]);
    if (!mounted.current) return;
    if (setupResult.status === "fulfilled") setSetup(setupResult.value);
    if (overviewResult.status === "fulfilled") {
      setConnections(overviewResult.value.connections);
      setWorkspaceId(overviewResult.value.workspaceId);
    } else {
      setConnections([]);
    }
    setAssignments(assignmentResult.status === "fulfilled" ? assignmentResult.value : []);
    setAudit(auditResult.status === "fulfilled" ? auditResult.value : []);
    const failed = [overviewResult, assignmentResult, auditResult].find((result) => result.status === "rejected");
    setLoadError(failed && failed.status === "rejected" ? errorCode(failed.reason) : null);
    setNow(Date.now());
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
    void agentsApi.list().then(
      (rows) => {
        if (mounted.current) setAgents(rows.map((row) => ({ id: row.id, name: row.name, webChatUrl: row.webChatUrl ?? null })));
      },
      () => undefined,
    );
  }, [reload]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const guarded = useCallback(
    async (setError: (value: string | null) => void, work: () => Promise<unknown>) => {
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
    },
    [reload],
  );

  const identityOff = setup !== null && !setup.enabled;
  const setupRequired = identityOff || (isSetupRequired(loadError) && connections.length === 0);
  const drawerConnection = connections.find((row) => row.id === drawerId) ?? null;
  const steps = readinessSteps(connections, assignments, audit);
  const allReady = steps.every((step) => step.done);
  const activeAssignments = assignments.filter((row) => row.active).length;
  const failedWithoutSetup = loadError && !isSetupRequired(loadError) ? loadError : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PageHeader
          title="Identity"
          subtitle="Who your agents talk to, and what each person may see"
          actions={
            setupRequired ? undefined : (
              <button type="button" className={PRIMARY} onClick={() => setConnectKind("handoff")}>
                <LuPlus className="block size-3.5" aria-hidden />
                Add connection
              </button>
            )
          }
        />

        {setupRequired ? (
          <div className="px-5 py-7">
            <SetupRequired
              mode={setup?.mode ?? "embedded"}
              busy={loading || busy}
              error={setupError}
              onEnable={() => void guarded(setSetupError, () => identityApi.enableIdentity())}
              onRetry={() => { setLoading(true); void reload().finally(() => { if (mounted.current) setLoading(false); }); }}
            />
          </div>
        ) : (
          <>
            <FilterTabs
              activeId={tab}
              onChange={(id) => setTab(id as TabId)}
              tabs={[
                { id: "connections", label: "Connections", count: connections.length },
                { id: "people", label: "People & access", count: activeAssignments },
                { id: "check", label: "Check access" },
                { id: "activity", label: "Activity", count: audit.length },
                { id: "setup", label: "Setup" },
              ]}
            />
            <div className="flex flex-col gap-6 px-5 py-6">
              {failedWithoutSetup ? <IdentityError code={failedWithoutSetup} /> : null}
              {!loading && !allReady ? <Readiness steps={steps} onPick={setTab} /> : null}
              <SectionHead title={TAB_COPY[tab].title} subtitle={TAB_COPY[tab].subtitle} />
              {panelError ? <IdentityError code={panelError} /> : null}

              {tab === "connections" ? (
                <ConnectionsPanel
                  connections={connections}
                  loading={loading}
                  onOpen={(id) => { setDrawerError(null); setDrawerId(id); }}
                  onAdd={setConnectKind}
                />
              ) : null}
              {tab === "people" ? (
                <PeoplePanel
                  assignments={assignments}
                  hasConnections={connections.some((row) => row.active && row.kind !== "service")}
                  busy={busy}
                  onAdd={() => setAssigning({ editing: null })}
                  onEdit={(row) => setAssigning({ editing: row })}
                  onRevoke={(row) => void guarded(setPanelError, () => identityApi.revokeAssignment(row.id))}
                />
              ) : null}
              {tab === "check" ? <CheckAccessPanel assignments={assignments} workspaceId={workspaceId} /> : null}
              {tab === "setup" && setup ? (
                <SetupPanel setup={setup} busy={busy} error={setupError} run={(work) => void guarded(setSetupError, work)} />
              ) : null}
              {tab === "activity" ? (
                <ActivityPanel events={audit} assignments={assignments} busy={busy} now={now} onRefresh={() => void guarded(setPanelError, async () => undefined)} />
              ) : null}
            </div>
          </>
        )}
      </div>

      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-t-[#ffffff12] px-7">
        <span className={`text-xs leading-normal text-[#8b8f98] ${MONO}`}>{workspaceId ? `workspace ${workspaceId}` : ""}</span>
        <span className="text-xs leading-normal text-[#8b8f98]">Customers sign in with your provider. Workspace owners keep their own login.</span>
      </footer>

      {drawerConnection ? (
        <ConnectionDrawer
          connection={drawerConnection}
          busy={busy}
          error={drawerError}
          recordedTest={tested.has(drawerConnection.id)}
          run={(work) => void guarded(setDrawerError, work)}
          onRecordedTest={() => setTested((current) => new Set(current).add(drawerConnection.id))}
          onClose={() => setDrawerId(null)}
        />
      ) : null}

      {connectKind ? (
        <IdentityConnectDialog
          initialKind={connectKind}
          agents={agents}
          workspaceId={workspaceId}
          existingIds={connections.map((row) => row.id)}
          onClose={() => setConnectKind(null)}
          onCreated={(id) => {
            setConnectKind(null);
            setTab("connections");
            setDrawerError(null);
            setDrawerId(id);
            void reload();
          }}
        />
      ) : null}

      {assigning ? (
        <AssignmentDialog
          connections={connections}
          assignments={assignments}
          agents={agents}
          editing={assigning.editing}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            setTab("people");
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
