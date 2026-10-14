import { useCallback, useEffect, useRef, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createHttpSource } from "./catalog/httpSource";
import { createRunCatalog } from "./catalog/runCatalog";
import { RunCatalogProvider, useRunCatalog } from "./catalog/useRunCatalog";
import {
  bucketViews,
  heldWaitingCount,
  waitingView,
} from "./catalog/views";
import { AppRail as LegacyAppRail } from "./components/AppRail";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { NewRunPage } from "./pages/NewRunPage";
import { InboxPage } from "./pages/InboxPage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { TasksPage } from "./pages/TasksPage";
import { TriggersPage } from "./pages/TriggersPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { ConnectionDetailPage } from "./redesign/connections/ConnectionDetailPage";
import { SkillsPage } from "./pages/SkillsPage";
import { ExtensionsPage } from "./pages/ExtensionsPage";
import { CatalogPage } from "./pages/CatalogPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ProviderConnectPage } from "./pages/ProviderConnectPage";
import { WorkshopPage } from "./pages/WorkshopPage";
import { loadProviderAuthReadiness } from "./providers/readiness";
import {
  navigate,
  parseHash,
  runArtifactPath,
  runEnvelopePath,
  runStagePath,
  runStreamPath,
  catalogPath,
  type Route,
} from "./routes";
import { applyRedesignAttribute, useRedesign } from "./redesign/flag";
import { StageEditorPage } from "./redesign/editor/StageEditorPage";
import { AppShell as RedesignAppShell } from "./redesign/shell/AppShell";
import { AppRail as RedesignAppRail } from "./redesign/shell/AppRail";
import { ConsoleOverlays } from "./redesign/ConsoleOverlays";
import { ControlTokenGate } from "./redesign/ControlTokenGate";
import { workspaceLabelFromSnapshot } from "./redesign/inbox/inboxViews";
import {
  readNotifyPreference,
  useWaitingNotifications,
  type NotifyPreference,
} from "./useWaitingNotifications";

function railActiveId(route: Route, redesignOn: boolean): string {
  if (route.name === "connect") return "settings";
  if (route.name === "detail") return "runs";
  if (route.name === "new") return "inbox";
  if (route.name === "pipeline") return "pipelines";
  if (route.name === "task") return "tasks";
  if (route.name === "trigger") return "triggers";
  if (route.name === "connection") return "connections";
  if (redesignOn) {
    if (route.name === "catalog" || route.name === "stage") return "catalog";
    if (route.name === "skill" || route.name === "skills") return "catalog";
    if (
      route.name === "extensions" ||
      route.name === "extensionPackage" ||
      route.name === "extensionFile"
    ) {
      return "catalog";
    }
  } else {
    if (route.name === "skill") return "skills";
    if (
      route.name === "extensionPackage" ||
      route.name === "extensionFile"
    ) {
      return "extensions";
    }
  }
  return route.name;
}

function ConsoleRoot() {
  const redesignOn = useRedesign();
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [notifyPreference, setNotifyPreference] =
    useState<NotifyPreference>(readNotifyPreference);
  const [authBoot, setAuthBoot] = useState<
    "loading" | "needs_connect" | "ready"
  >("loading");
  const { snapshot } = useRunCatalog();
  const paletteOpenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    applyRedesignAttribute();
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) {
      window.location.hash = "#/inbox";
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useWaitingNotifications(notifyPreference === "system");

  useEffect(() => {
    let cancelled = false;
    void loadProviderAuthReadiness()
      .then((readiness) => {
        if (cancelled) return;
        setAuthBoot(readiness.ready ? "ready" : "needs_connect");
      })
      .catch(() => {
        if (!cancelled) setAuthBoot("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const waitingCount = waitingView(snapshot).length;
  const inFlightCount = bucketViews(snapshot).inFlight.length;
  const health = snapshot.health;
  const workspace = workspaceLabelFromSnapshot(snapshot);
  const heldCount = heldWaitingCount(snapshot, health);

  const go = useCallback((path: string) => {
    navigate(path);
  }, []);

  useEffect(() => {
    if (!redesignOn) return;
    if (route.name === "skills") {
      go(catalogPath({ tab: "skills" }));
    } else if (route.name === "skill") {
      go(catalogPath({ tab: "skills", skill: route.skillName }));
    } else if (route.name === "extensions") {
      go(catalogPath({ tab: "stages" }));
    }
  }, [redesignOn, route, go]);

  const onRailNavigate = useCallback(
    (id: string) => {
      if (id === "catalog") {
        go(catalogPath({ tab: "stages" }));
        return;
      }
      go(`/${id}`);
    },
    [go],
  );

  const homeAfterConnect = "/inbox";

  let content;
  if (route.name === "inbox") {
    content = (
      <InboxPage
        onOpen={(id) => go(runStreamPath(id))}
        onNew={() => go("/new")}
        onOpenRuns={() => go("/runs")}
      />
    );
  } else if (route.name === "new") {
    content = redesignOn ? (
      <InboxPage
        onOpen={(id) => go(runStreamPath(id))}
        onNew={() => go("/new")}
        onOpenRuns={() => go("/runs")}
      />
    ) : (
      <NewRunPage
        onStarted={(id) => go(runStreamPath(id))}
        initialPipelinePath={route.pipelineId}
        initialTaskPath={route.taskPath}
        initialProjectRoot={route.projectRoot}
      />
    );
  } else if (route.name === "detail") {
    content = (
      <RunDetailPage
        runId={route.runId}
        view={route.view}
        onBack={() => go("/runs")}
        onReran={(id) => go(runStreamPath(id))}
        onOpenStream={(stageId) =>
          go(stageId ? runStagePath(route.runId, stageId) : runStreamPath(route.runId))
        }
        onOpenArtifact={(path) => go(runArtifactPath(route.runId, path))}
        onOpenEnvelope={(stageId) => go(runEnvelopePath(route.runId, stageId))}
      />
    );
  } else if (route.name === "runs") {
    content = (
      <RunsPage
        onOpen={(id) => go(runStreamPath(id))}
        onNew={() => go("/new")}
      />
    );
  } else if (route.name === "pipelines") {
    content = <PipelinesPage onNew={go} />;
  } else if (route.name === "pipeline") {
    content = (
      <PipelinesPage
        pipelineId={route.pipelineId}
        projectRoot={route.projectRoot}
        onNew={go}
      />
    );
  } else if (route.name === "tasks") {
    content = <TasksPage onNew={go} />;
  } else if (route.name === "task") {
    content = <TasksPage taskId={route.taskId} onNew={go} />;
  } else if (route.name === "triggers") {
    content = <TriggersPage />;
  } else if (route.name === "connections") {
    content = <ConnectionsPage />;
  } else if (route.name === "connection") {
    content = <ConnectionDetailPage connectionId={route.connectionId} />;
  } else if (route.name === "trigger") {
    content = (
      <TriggersPage
        triggerId={route.triggerId}
        projectRoot={route.projectRoot}
      />
    );
  } else if (route.name === "catalog") {
    content = (
      <CatalogPage tab={route.tab} skillName={route.skillName} />
    );
  } else if (route.name === "stage") {
    content = (
      <StageEditorPage
        stagePath={route.path}
        projectRoot={route.projectRoot}
      />
    );
  } else if (route.name === "skills") {
    content = <SkillsPage />;
  } else if (route.name === "skill") {
    content = <SkillsPage skillName={route.skillName} />;
  } else if (route.name === "extensions") {
    content = <ExtensionsPage />;
  } else if (route.name === "extensionPackage") {
    content = redesignOn ? (
      <CatalogPage
        tab="extensions"
        packageScope={route.scope}
        packageSource={route.source}
      />
    ) : (
      <ExtensionsPage
        packageScope={route.scope}
        packageSource={route.source}
      />
    );
  } else if (route.name === "extensionFile") {
    content = redesignOn ? (
      <CatalogPage tab="extensions" filePath={route.path} />
    ) : (
      <ExtensionsPage filePath={route.path} />
    );
  } else if (route.name === "settings") {
    content = (
      <SettingsPage
        notifyPreference={notifyPreference}
        onNotifyChange={setNotifyPreference}
      />
    );
  } else if (route.name === "connect") {
    content = (
      <ProviderConnectPage
        onComplete={() => {
          setAuthBoot("ready");
          go(homeAfterConnect);
        }}
      />
    );
  } else if (route.name === "workshop") {
    content = (
      <WorkshopPage
        sessionId={route.sessionId}
        pipelinePath={route.pipelinePath}
        taskPath={route.taskPath}
        projectRoot={route.projectRoot}
      />
    );
  } else {
    content = (
      <InboxPage
        onOpen={(id) => go(runStreamPath(id))}
        onNew={() => go("/new")}
        onOpenRuns={() => go("/runs")}
      />
    );
  }

  if (
    authBoot === "needs_connect" &&
    route.name !== "settings" &&
    route.name !== "connect"
  ) {
    content = (
      <ProviderConnectPage
        onComplete={() => {
          setAuthBoot("ready");
          go(homeAfterConnect);
        }}
      />
    );
  }

  if (redesignOn) {
    return (
      <Theme theme={neutralTheme} mode="dark">
        <RedesignAppShell
          rail={
            <RedesignAppRail
              activeId={railActiveId(route, redesignOn)}
              onNavigate={onRailNavigate}
              waitingCount={waitingCount}
              inFlightCount={inFlightCount}
              health={health}
              workspaceName={workspace.name}
              workspaceSubtitle={workspace.subtitle}
              heldWaitingCount={heldCount}
              onOpenPalette={() => paletteOpenRef.current?.()}
            />
          }
        >
          {content}
          <ConsoleOverlays
            route={route}
            redesignOn={redesignOn}
            workspaceName={workspace.name}
            onStarted={(id) => go(runStreamPath(id))}
            onOpenPaletteRef={(open) => {
              paletteOpenRef.current = open;
            }}
          />
        </RedesignAppShell>
      </Theme>
    );
  }

  return (
    <Theme theme={neutralTheme} mode="dark">
      <div className="app">
        <LegacyAppRail
          activeId={railActiveId(route, false)}
          onNavigate={onRailNavigate}
          waitingCount={waitingCount}
          health={health}
        />
        <main className="main">{content}</main>
      </div>
    </Theme>
  );
}

export function App() {
  const [catalog] = useState(() =>
    createRunCatalog({ source: createHttpSource() }),
  );

  return (
    <RunCatalogProvider catalog={catalog}>
      <ControlTokenGate />
      <ConsoleRoot />
    </RunCatalogProvider>
  );
}
