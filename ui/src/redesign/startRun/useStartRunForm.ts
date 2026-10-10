import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchCatalogValidate,
  fetchPipelines,
  fetchTasks,
  startRunWithDetails,
  type PipelineListing,
  type StartRunResult,
  type TaskListing,
  type StageSnapshot,
} from "../../api";
import { stageMayAsk } from "../../catalogJoin";
import type { CatalogSnapshot } from "../../catalog/source";
import { waitingRunsAmongView } from "../../catalog/views";
import { loadProviderAuthReadiness } from "../../providers/readiness";
import type { MiniStage } from "../../components/MiniTrack";

export type PipelineValidationState =
  | "idle"
  | "checking"
  | "valid"
  | "invalid"
  | "unknown";

export type UseStartRunFormOptions = {
  open: boolean;
  snapshot: CatalogSnapshot;
  catalogError: string | null;
  initialTaskPath?: string;
  initialPipelinePath?: string;
  initialProjectRoot?: string;
  onStarted: (runId: string) => void;
};

function preferCatalogRow<T extends { path: string; project_root?: string }>(
  rows: readonly T[],
  path: string | undefined,
  projectRoot: string | undefined,
): T | undefined {
  if (path && projectRoot) {
    const exact = rows.find(
      (row) => row.path === path && row.project_root === projectRoot,
    );
    if (exact) return exact;
  }
  if (path) {
    const byPath = rows.find((row) => row.path === path);
    if (byPath) return byPath;
  }
  return rows[0];
}

function selectedCatalogRow<T extends { path: string; project_root?: string }>(
  rows: readonly T[],
  path: string,
  projectRoot: string | undefined,
): T | null {
  if (!path) return null;
  return (
    rows.find((row) => row.path === path && row.project_root === projectRoot) ??
    null
  );
}

export function useStartRunForm({
  open,
  snapshot,
  catalogError,
  initialTaskPath,
  initialPipelinePath,
  initialProjectRoot,
  onStarted,
}: UseStartRunFormOptions) {
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [task, setTaskPath] = useState("");
  const [taskRoot, setTaskRoot] = useState<string | undefined>(undefined);
  const [pipeline, setPipelinePath] = useState("");
  const [pipelineRoot, setPipelineRoot] = useState<string | undefined>(undefined);
  const [taskQuery, setTaskQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<Extract<
    StartRunResult,
    { ok: false }
  > | null>(null);
  const [authGateMessage, setAuthGateMessage] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [pipelineValidation, setPipelineValidation] =
    useState<PipelineValidationState>("idle");
  const [pipelineValidationDetail, setPipelineValidationDetail] = useState<
    string | null
  >(null);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const health = snapshot.health;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalogLoading(true);
    void (async () => {
      try {
        const [t, p, readiness] = await Promise.all([
          fetchTasks(),
          fetchPipelines(),
          loadProviderAuthReadiness(),
        ]);
        if (cancelled) return;
        setTasks(t.tasks);
        setPipelines(p.pipelines);
        setProviderReady(readiness.ready);
        if (!readiness.ready) {
          setAuthGateMessage(
            readiness.message ??
              "Connect providers before starting a run.",
          );
        } else {
          setAuthGateMessage(null);
        }
        const preferredTask = preferCatalogRow(
          t.tasks,
          initialTaskPath,
          initialProjectRoot,
        );
        const preferredPipeline = preferCatalogRow(
          p.pipelines,
          initialPipelinePath,
          initialProjectRoot,
        );
        setTaskPath(preferredTask?.path ?? "");
        setTaskRoot(preferredTask?.project_root);
        setPipelinePath(preferredPipeline?.path ?? "");
        setPipelineRoot(preferredPipeline?.project_root);
        setError(null);
        setStartFailure(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialTaskPath, initialPipelinePath, initialProjectRoot]);

  const selectedTask = selectedCatalogRow(tasks, task, taskRoot);
  const selectedPipeline = selectedCatalogRow(pipelines, pipeline, pipelineRoot);

  const setTask = useCallback((path: string, projectRoot?: string) => {
    setTaskPath(path);
    setTaskRoot(projectRoot);
  }, []);

  const setPipeline = useCallback((path: string, projectRoot?: string) => {
    setPipelinePath(path);
    setPipelineRoot(projectRoot);
  }, []);

  const filteredTasks = useMemo(() => {
    const q = taskQuery.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        t.goal.toLowerCase().includes(q) ||
        t.path.toLowerCase().includes(q),
    );
  }, [tasks, taskQuery]);

  const previewStages: MiniStage[] = useMemo(() => {
    if (!selectedPipeline) return [];
    return selectedPipeline.stages.map((s) => ({
      id: s.id,
      status: (stageMayAsk(s.gate_kinds)
        ? "waiting_for_input"
        : "pending") as StageSnapshot["status"],
    }));
  }, [selectedPipeline]);

  const slotsFull = health != null && health.slotsAvailable === 0;
  const heldWaiting =
    health != null
      ? waitingRunsAmongView(snapshot, health.activeRunIds).length
      : 0;

  const displayError =
    error ?? (health == null && catalogError ? catalogError : null);

  const cliLine =
    selectedTask && selectedPipeline
      ? `sf run --task ${selectedTask.path} --pipeline ${selectedPipeline.path}`
      : "sf run --task <task> --pipeline <pipeline>";

  useEffect(() => {
    if (!open || !pipeline) {
      setPipelineValidation("idle");
      setPipelineValidationDetail(null);
      return;
    }
    let cancelled = false;
    setPipelineValidation("checking");
    setPipelineValidationDetail(null);
    void fetchCatalogValidate({
      pipeline,
      strict: true,
      ...(selectedPipeline?.project_root
        ? { project_root: selectedPipeline.project_root }
        : {}),
    })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPipelineValidation("valid");
        } else {
          setPipelineValidation("invalid");
          const first = result.findings.find((f) => f.severity === "error");
          setPipelineValidationDetail(
            first?.message ?? `${result.summary.errors} validation error(s)`,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPipelineValidation("unknown");
          setPipelineValidationDetail("Checked on start");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, pipeline, selectedPipeline?.project_root]);

  const submit = useCallback(async () => {
    if (!task || !pipeline) {
      setError("Pick a task and a pipeline.");
      return;
    }
    setStarting(true);
    setError(null);
    setStartFailure(null);
    setAuthGateMessage(null);
    try {
      const readiness = await loadProviderAuthReadiness();
      setProviderReady(readiness.ready);
      if (!readiness.ready) {
        setAuthGateMessage(
          readiness.message ??
            "Connect providers before starting a run.",
        );
        setStarting(false);
        return;
      }
    } catch (err) {
      setAuthGateMessage(err instanceof Error ? err.message : String(err));
      setStarting(false);
      return;
    }
    const result = await startRunWithDetails(
      task,
      pipeline,
      selectedPipeline?.project_root ?? selectedTask?.project_root,
    );
    setStarting(false);
    if (result.ok) {
      onStarted(result.runId);
      return;
    }
    setStartFailure(result);
  }, [
    task,
    pipeline,
    onStarted,
    selectedPipeline?.project_root,
    selectedTask?.project_root,
  ]);

  return {
    tasks,
    pipelines,
    task,
    setTask,
    pipeline,
    setPipeline,
    taskQuery,
    setTaskQuery,
    filteredTasks,
    selectedTask,
    selectedPipeline,
    previewStages,
    slotsFull,
    heldWaiting,
    health,
    displayError,
    starting,
    startFailure,
    authGateMessage,
    providerReady,
    pipelineValidation,
    pipelineValidationDetail,
    catalogLoading,
    cliLine,
    submit,
    canStart:
      Boolean(task && pipeline) &&
      !slotsFull &&
      !starting &&
      providerReady !== false &&
      pipelineValidation !== "invalid",
  };
}
