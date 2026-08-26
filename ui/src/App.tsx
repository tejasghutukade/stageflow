import { useCallback, useEffect, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createHttpSource } from "./catalog/httpSource";
import { createRunCatalog } from "./catalog/runCatalog";
import { RunCatalogProvider, useRunCatalog } from "./catalog/useRunCatalog";
import { waitingView } from "./catalog/views";
import { AppRail } from "./components/AppRail";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { NewRunPage } from "./pages/NewRunPage";
import { TodayPage } from "./pages/TodayPage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { TasksPage } from "./pages/TasksPage";
import { SkillsPage } from "./pages/SkillsPage";
import { ExtensionsPage } from "./pages/ExtensionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ProviderConnectPage } from "./pages/ProviderConnectPage";
import { fetchProvidersDetect } from "./api";
import { needsFirstRun } from "./providers/helpers";
import {
  navigate,
  parseHash,
  runArtifactPath,
  runEnvelopePath,
  runStreamPath,
  type Route,
} from "./routes";
import { readThemePreference, type ThemeMode } from "./themePreference";
import {
  readNotifyPreference,
  useWaitingNotifications,
  type NotifyPreference,
} from "./useWaitingNotifications";

function railActiveId(route: Route): string {
  if (route.name === "connect") return "settings";
  if (route.name === "detail") return "runs";
  if (route.name === "new") return "today";
  if (route.name === "pipeline") return "pipelines";
  if (route.name === "task") return "tasks";
  if (route.name === "skill") return "skills";
  if (
    route.name === "extensionPackage" ||
    route.name === "extensionFile"
  ) {
    return "extensions";
  }
  return route.name;
}

function AppShell() {
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemePreference);
  const [notifyPreference, setNotifyPreference] =
    useState<NotifyPreference>(readNotifyPreference);
  const [authBoot, setAuthBoot] = useState<
    "loading" | "needs_connect" | "ready"
  >("loading");
  const { snapshot } = useRunCatalog();

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) {
      window.location.hash = "#/today";
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useWaitingNotifications(notifyPreference === "system");

  useEffect(() => {
    let cancelled = false;
    void fetchProvidersDetect()
      .then((detect) => {
        if (cancelled) return;
        setAuthBoot(needsFirstRun(detect) ? "needs_connect" : "ready");
      })
      .catch(() => {
        if (!cancelled) setAuthBoot("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const waitingCount = waitingView(snapshot).length;
  const health = snapshot.health;

  const go = useCallback((path: string) => {
    navigate(path);
  }, []);

  const onRailNavigate = useCallback(
    (id: string) => {
      go(`/${id}`);
    },
    [go],
  );

  let content;
  if (route.name === "new") {
    content = (
      <NewRunPage
        onStarted={(id) => go(runStreamPath(id))}
        initialPipelinePath={route.pipelineId}
        initialTaskPath={route.taskPath}
      />
    );
  } else if (route.name === "detail") {
    content = (
      <RunDetailPage
        runId={route.runId}
        view={route.view}
        onBack={() => go("/runs")}
        onReran={(id) => go(runStreamPath(id))}
        onOpenStream={() => go(runStreamPath(route.runId))}
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
      <PipelinesPage pipelineId={route.pipelineId} onNew={go} />
    );
  } else if (route.name === "tasks") {
    content = <TasksPage onNew={go} />;
  } else if (route.name === "task") {
    content = <TasksPage taskId={route.taskId} onNew={go} />;
  } else if (route.name === "skills") {
    content = <SkillsPage />;
  } else if (route.name === "skill") {
    content = <SkillsPage skillName={route.skillName} />;
  } else if (route.name === "extensions") {
    content = <ExtensionsPage />;
  } else if (route.name === "extensionPackage") {
    content = (
      <ExtensionsPage
        packageScope={route.scope}
        packageSource={route.source}
      />
    );
  } else if (route.name === "extensionFile") {
    content = <ExtensionsPage filePath={route.path} />;
  } else if (route.name === "settings") {
    content = (
      <SettingsPage
        themeMode={themeMode}
        onThemeChange={setThemeMode}
        notifyPreference={notifyPreference}
        onNotifyChange={setNotifyPreference}
      />
    );
  } else if (route.name === "connect") {
    content = (
      <ProviderConnectPage
        onComplete={() => {
          setAuthBoot("ready");
          go("/today");
        }}
      />
    );
  } else {
    content = (
      <TodayPage
        onOpen={(id) => go(runStreamPath(id))}
        onOpenArtifact={(id, path) => go(runArtifactPath(id, path))}
        onNew={() => go("/new")}
        onSeeRuns={() => go("/runs")}
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
          go("/today");
        }}
      />
    );
  }

  return (
    <Theme theme={neutralTheme} mode={themeMode}>
      <div className="app">
        <AppRail
          activeId={railActiveId(route)}
          onNavigate={onRailNavigate}
          waitingCount={waitingCount}
          health={health}
        />
        <main className="main">
          {content}
        </main>
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
      <AppShell />
    </RunCatalogProvider>
  );
}
