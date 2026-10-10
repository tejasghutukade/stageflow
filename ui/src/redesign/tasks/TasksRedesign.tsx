import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuArrowUpDown,
  LuCircleDashed,
  LuCopy,
  LuFileCode,
  LuFolder,
  LuGitBranch,
  LuGithub,
  LuHammer,
  LuHand,
  LuMinus,
  LuPencil,
  LuPlay,
  LuPlus,
  LuSearch,
  LuX,
} from "react-icons/lu";
import {
  fetchCatalogValidate,
  fetchPipelines,
  fetchTask,
  fetchTasks,
  type CatalogValidationResult,
  type PipelineListing,
  type TaskDetailFile,
  type TaskListing,
} from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { navigate, newRunPath, runStreamPath, taskPath, workshopPath } from "../../routes";
import { showToast } from "../../toast";
import { formatDurationShort } from "../editor/editorGraphLayout";
import { useHotkeys } from "../keys";
import { TaskFormDialog, type TaskFormInitial, type TaskFormMode } from "./TaskFormDialog";
import { TaskRunPill, TasksColumnHeader, TasksTableRow } from "./TasksTableRow";
import {
  buildTaskRowViews,
  catalogRelativePath,
  filterRowViewsByTab,
  filterTasksBySearch,
  formatUsd,
  newestWaitingRun,
  openGateCount,
  parentDirectory,
  parseConstraintItems,
  relativeAgo,
  runDurationMs,
  runHistorySegments,
  shortRunId,
  taskCheckoutView,
  taskFolderLabel,
  taskLastRunKind,
  taskRowKey,
  validationStatusLabel,
  type TaskFilterTab,
  type TaskRowView,
} from "./taskViews";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const NOWRAP = "[white-space-collapse:collapse] [text-wrap-mode:nowrap]";

function stageBarColor(status: string): string {
  if (status === "succeeded" || status === "skipped") return "bg-[#4cc38a]";
  if (status === "failed") return "bg-[#f2645a]";
  if (status === "running" || status === "waiting_for_input" || status === "interrupted") {
    return "bg-[#f5b544]";
  }
  return "bg-[#ffffff24]";
}

function rootBasename(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts.at(-1);
}
const EYEBROW = `text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase ${NOWRAP}`;
const KEYCAP_DARK = `bg-[#1a1c21] border border-[#ffffff1a] text-[#8b8f98] ${MONO} text-[11px] leading-normal rounded-sm px-[5px] py-0`;
const KEYCAP_LIGHT = `border border-[#0c0d0f2e] text-[#5a5d66] ${MONO} text-[11px] leading-normal rounded-sm px-[5px] py-0`;
const FOOTER_KEYCAP = `bg-[#1a1c21] border border-[#ffffff1a] text-[#a7aab2] ${MONO} text-[11px] leading-normal rounded-sm px-[5px] py-0`;
const SECONDARY_BTN = "flex h-8 shrink-0 items-center bg-[#1a1c21] border border-[#ffffff1a] rounded-lg py-0";

type DialogState = { mode: TaskFormMode; initial: TaskFormInitial } | null;

function FilterChip({
  active,
  label,
  icon,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  icon?: ReactNode;
  count: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-7 items-center rounded-md px-2.5 py-0 gap-1.5 ${
        active ? "bg-[#1a1c21] border border-[#ffffff1a]" : "border border-transparent"
      }`}
    >
      {icon}
      <span
        className={`font-sans text-[13px] leading-normal ${NOWRAP} ${
          active ? "font-medium text-[#ecedee]" : "text-[#a7aab2]"
        }`}
      >
        {label}
      </span>
      {count}
    </button>
  );
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {keys.map((key, index) => (
        <span key={key} className="flex items-center gap-1.5">
          {index > 0 ? <span className="text-[#8b8f98] font-sans text-xs leading-normal">/</span> : null}
          <span className={FOOTER_KEYCAP}>{key}</span>
        </span>
      ))}
      <span className={`text-[#8b8f98] font-sans text-xs leading-normal ${NOWRAP}`}>{label}</span>
    </div>
  );
}

function FooterDot() {
  return <span className="text-[#8b8f98] font-sans text-xs leading-normal">·</span>;
}

function TaskInspector({
  row,
  detail,
  detailLoading,
  onEdit,
  onStartRun,
  onDuplicate,
}: {
  row: TaskRowView;
  detail: TaskDetailFile | null;
  detailLoading: boolean;
  onEdit: () => void;
  onStartRun: () => void;
  onDuplicate: () => void;
}) {
  const { task, runs, pipeline } = row;
  const goal = detail?.goal ?? task.goal;
  const context = detail?.context?.trim();
  const constraints = parseConstraintItems(detail?.constraints);
  const checkout = taskCheckoutView(detail);
  const segments = runHistorySegments(runs);
  const waiting = newestWaitingRun(runs);
  const gates = openGateCount(runs);
  const history = runs.slice(0, 8);
  const workshopHref = pipeline?.path
    ? `#${workshopPath({
        pipeline: pipeline.path,
        task: task.path,
        ...(task.project_root ? { project_root: task.project_root } : {}),
      })}`
    : null;

  return (
    <div className="flex w-full min-h-0 flex-col flex-1">
      <div className="flex w-full flex-col border-b px-4 py-2.5 gap-1 border-b-[#ffffff12]">
        <div className="flex items-center gap-1.5">
          <div className={`flex-1 ${EYEBROW}`}>Task</div>
          <button
            type="button"
            onClick={onEdit}
            className="flex h-[26px] items-center rounded-md px-2 py-0 gap-1.5 hover:bg-[#1a1c21]"
          >
            <LuPencil className="size-3 block text-[#a7aab2]" aria-hidden />
            <span className={`text-[#a7aab2] font-sans text-xs font-medium leading-normal ${NOWRAP}`}>
              Edit YAML
            </span>
            <span className={KEYCAP_DARK}>E</span>
          </button>
        </div>
        <div className={`truncate text-[#ecedee] ${MONO} text-[15px] font-semibold leading-normal`}>
          {task.id}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <LuFileCode className="size-3 block shrink-0 text-[#8b8f98]" aria-hidden />
          <span className={`truncate text-[#8b8f98] ${MONO} text-xs leading-normal`} title={task.path}>
            {task.path}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex w-full flex-col border-b px-4 py-3 gap-3 border-b-[#ffffff12]">
          <div className="flex flex-col gap-1">
            <div className={EYEBROW}>Goal</div>
            <div className="text-[#ecedee] font-sans text-sm font-medium leading-[1.4]">
              {goal}
            </div>
          </div>
          {detailLoading ? (
            <div className="text-[#8b8f98] font-sans text-xs leading-normal">Loading…</div>
          ) : null}
          {context ? (
            <div className="flex flex-col gap-1">
              <div className={EYEBROW}>Context</div>
              <div className="whitespace-pre-wrap text-[#a7aab2] font-sans text-[13px] leading-normal">
                {context}
              </div>
            </div>
          ) : null}
          {constraints.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <div className={EYEBROW}>Constraints</div>
                <div className={`text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>
                  {constraints.length}
                </div>
              </div>
              {constraints.map((item, index) => (
                <div key={`${index}-${item}`} className="flex items-start gap-2">
                  <LuMinus className="mt-[3px] size-3 block shrink-0 text-[#8b8f98]" aria-hidden />
                  <span className="text-[#ecedee] font-sans text-[13px] leading-normal">{item}</span>
                </div>
              ))}
            </div>
          ) : null}
          {checkout ? (
            <div className="flex items-center gap-3">
              <div className={EYEBROW}>Checkout</div>
              <div className="flex w-fit min-w-0 h-[26px] items-center bg-[#1a1c21] border border-[#ffffff1a] rounded-md px-2 py-0 gap-1.5">
                <LuGitBranch className="size-3 block shrink-0 text-[#a7aab2]" aria-hidden />
                {checkout.target ? (
                  <span className={`truncate text-[#ecedee] ${MONO} text-xs leading-normal`}>
                    {checkout.target}
                  </span>
                ) : null}
                {checkout.repository ? (
                  <>
                    {checkout.target ? (
                      <span className={`text-[#8b8f98] font-sans text-xs leading-normal ${NOWRAP}`}>
                        from
                      </span>
                    ) : null}
                    <span className={`truncate text-[#a7aab2] ${MONO} text-xs leading-normal`}>
                      {checkout.repository}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex w-full flex-col">
          <div className="flex w-full h-8 shrink-0 justify-between items-center px-4 py-0">
            <div className={EYEBROW}>Run history</div>
            <div className="flex items-center gap-1.5">
              {segments.map((segment, index) => (
                <span key={segment.kind} className="flex items-center gap-1.5">
                  {index > 0 ? (
                    <span className="text-[#8b8f98] font-sans text-xs leading-normal">·</span>
                  ) : null}
                  <span
                    className={`${MONO} text-xs leading-normal ${NOWRAP} ${
                      segment.kind === "runs"
                        ? "text-[#a7aab2]"
                        : segment.kind === "cost"
                          ? "text-[#ecedee]"
                          : "text-[#f5b544]"
                    }`}
                  >
                    {segment.text}
                  </span>
                </span>
              ))}
            </div>
          </div>
          {history.length === 0 ? (
            <div className="border-t border-t-[#ffffff12] px-4 py-[7px] text-[#8b8f98] font-sans text-xs leading-normal">
              No runs yet.
            </div>
          ) : null}
          {history.map((run, index) => {
            const kind = taskLastRunKind(run);
            const durationMs = runDurationMs(run);
            const dim = kind === "cancelled";
            const last = index === history.length - 1;
            return (
              <button
                key={run.run_id}
                type="button"
                onClick={() => navigate(runStreamPath(run.run_id))}
                className={`flex w-full flex-col border-t px-4 py-[7px] gap-1.5 border-t-[#ffffff12] text-left hover:bg-[#1a1c21]${
                  last ? " border-b border-b-[#ffffff12]" : ""
                }${kind === "waiting" ? " bg-[#f5b5440a]" : ""}`}
              >
                <span className="flex w-full items-center gap-2">
                  <span
                    className={`${MONO} text-xs leading-normal ${NOWRAP} ${dim ? "text-[#a7aab2]" : "text-[#ecedee]"}`}
                    title={run.run_id}
                  >
                    {shortRunId(run.run_id)}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-[#8b8f98] ${MONO} text-xs leading-normal`}>
                    {run.pipeline_id}
                  </span>
                  <span className={`text-[#8b8f98] ${MONO} text-xs leading-normal ${NOWRAP}`}>
                    {relativeAgo(run.created_at)}
                  </span>
                  <TaskRunPill
                    kind={kind}
                    suffix={kind === "failed" ? run.failed_stage_id : undefined}
                  />
                </span>
                {run.stages.length > 0 || durationMs !== undefined || run.total_cost_usd !== undefined ? (
                  <span className="flex w-full items-center gap-2.5">
                    {run.stages.length > 0 ? (
                      <span className="flex min-w-0 flex-1 items-center gap-0.5" aria-hidden>
                        {run.stages.slice(0, 12).map((stage) => (
                          <span
                            key={stage.id}
                            title={`${stage.id} ${stage.status}`}
                            className={`h-1 min-w-1 flex-1 rounded-sm ${stageBarColor(stage.status)}`}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {durationMs !== undefined ? (
                      <span
                        className={`w-14 shrink-0 text-right ${MONO} text-xs leading-normal ${NOWRAP} ${dim ? "text-[#8b8f98]" : "text-[#a7aab2]"}`}
                      >
                        {formatDurationShort(durationMs)}
                      </span>
                    ) : null}
                    {run.total_cost_usd !== undefined ? (
                      <span
                        className={`w-11 shrink-0 text-right ${MONO} text-xs leading-normal ${dim ? "text-[#a7aab2]" : "text-[#ecedee]"}`}
                      >
                        {formatUsd(run.total_cost_usd)}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {kind === "failed" && run.failed_reason ? (
                  <span className="w-full min-w-0 truncate text-[#a7aab2] font-sans text-xs leading-normal">
                    {run.failed_reason}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex w-full flex-col shrink-0 border-t px-4 py-2.5 gap-2 border-t-[#ffffff12]">
        {waiting ? (
          <button
            type="button"
            onClick={() => navigate(runStreamPath(waiting.run_id))}
            className="flex w-full h-8 justify-center items-center bg-[#f5b544] shadow-[0px_0px_10px_rgba(245,181,68,0.35)] rounded-lg px-3 py-0 gap-2"
          >
            <LuHand className="size-3.5 block text-[#1a1306]" aria-hidden />
            <span className={`text-[#1a1306] font-sans text-[13px] font-medium leading-normal ${NOWRAP}`}>
              Answer open gate
            </span>
            <span className={`bg-[#1a130629] text-[#1a1306] ${MONO} text-[11px] font-semibold leading-normal rounded-full px-1.5 py-0`}>
              {gates}
            </span>
            <span className={`truncate text-[#1a1306b3] ${MONO} text-[11px] leading-normal`}>
              {waiting.waiting_kind
                ? `${waiting.waiting_stage_id} · ${waiting.waiting_kind}`
                : waiting.waiting_stage_id}
            </span>
          </button>
        ) : null}
        <div className="flex w-full items-center gap-1.5">
          <button
            type="button"
            onClick={onStartRun}
            className="flex h-8 justify-center items-center bg-[#ecedee] flex-1 rounded-lg px-2.5 py-0 gap-1.5"
          >
            <LuPlay className="size-3.5 block text-[#0c0d0f]" aria-hidden />
            <span className={`text-[#0c0d0f] font-sans text-[13px] font-medium leading-normal ${NOWRAP}`}>
              Start a run
            </span>
            <span className={KEYCAP_LIGHT}>S</span>
          </button>
          {workshopHref ? (
            <a href={workshopHref} className={`${SECONDARY_BTN} px-2.5 gap-1.5`}>
              <LuHammer className="size-3.5 block text-[#a7aab2]" aria-hidden />
              <span className={`text-[#ecedee] font-sans text-[13px] font-medium leading-normal ${NOWRAP}`}>
                Open in Workshop
              </span>
            </a>
          ) : null}
          <button type="button" onClick={onDuplicate} className={`${SECONDARY_BTN} px-2.5 gap-1.5`}>
            <LuCopy className="size-3.5 block text-[#a7aab2]" aria-hidden />
            <span className={`text-[#ecedee] font-sans text-[13px] font-medium leading-normal ${NOWRAP}`}>
              Duplicate
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function TasksRedesign({
  taskId,
  onNew,
}: {
  taskId?: string;
  onNew: (path: string) => void;
}) {
  const { snapshot, error: catalogError, loading: catalogLoading } = useRunCatalog();
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tab, setTab] = useState<TaskFilterTab>("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailFile | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [validation, setValidation] = useState<CatalogValidationResult | null>(null);
  const [validatedAt, setValidatedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<TaskListing[]> => {
    try {
      const t = await fetchTasks();
      setTasks(t.tasks);
      setError(null);
      return t.tasks;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchPipelines()
      .then((res) => {
        if (!cancelled) setPipelines(res.pipelines);
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    fetchCatalogValidate({ strict: true })
      .then((res) => {
        if (cancelled) return;
        setValidation(res);
        setValidatedAt(new Date().toISOString());
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const allRows = useMemo(
    () => buildTaskRowViews(tasks, snapshot, pipelines),
    [tasks, snapshot, pipelines],
  );

  const searchedRows = useMemo(() => {
    const keep = new Set(filterTasksBySearch(tasks, search).map(taskRowKey));
    return allRows.filter((row) => keep.has(row.key));
  }, [allRows, tasks, search]);

  const rows = useMemo(() => filterRowViewsByTab(searchedRows, tab), [searchedRows, tab]);

  const counts = useMemo(
    () => ({
      all: searchedRows.length,
      has_open_gate: filterRowViewsByTab(searchedRows, "has_open_gate").length,
      failing: filterRowViewsByTab(searchedRows, "failing").length,
      no_runs: filterRowViewsByTab(searchedRows, "no_runs").length,
    }),
    [searchedRows],
  );

  const showRoots = useMemo(
    () => new Set(tasks.map((task) => task.project_root ?? "")).size > 1,
    [tasks],
  );

  const selected = useMemo(() => {
    if (selectedKey) return rows.find((r) => r.key === selectedKey) ?? null;
    if (taskId) return rows.find((r) => r.task.id === taskId) ?? null;
    return null;
  }, [rows, selectedKey, taskId]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selected) setSelectedKey(rows[0]!.key);
  }, [rows, selected]);

  useEffect(() => {
    if (!taskId || tasks.length === 0) return;
    const current = tasks.find((task) => taskRowKey(task) === selectedKey);
    if (current?.id === taskId) return;
    const match = tasks.find((task) => task.id === taskId);
    if (match) setSelectedKey(taskRowKey(match));
  }, [taskId, tasks, selectedKey]);

  const selectedTask = selected?.task ?? null;

  useEffect(() => {
    if (!selectedTask) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    let cancelled = false;
    void fetchTask(selectedTask.id)
      .then((res) => {
        if (!cancelled) setDetail(res.task);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTask?.id, selectedTask?.path, selectedTask?.project_root, detailVersion]);

  const selectRow = useCallback((row: TaskRowView) => {
    setSelectedKey(row.key);
    navigate(taskPath(row.task.id));
  }, []);

  const startRun = useCallback(() => {
    if (!selected) return;
    const root = selected.pipeline?.project_root ?? selected.task.project_root;
    onNew(
      newRunPath({
        task: selected.task.path,
        ...(selected.pipeline?.path ? { pipeline: selected.pipeline.path } : {}),
        ...(root ? { project_root: root } : {}),
      }),
    );
  }, [selected, onNew]);

  const openCreate = useCallback(() => {
    setDialog({
      mode: "create",
      initial: { directory: "examples" },
    });
  }, []);

  const openImport = useCallback(() => {
    setDialog({
      mode: "import",
      initial: { directory: "examples" },
    });
  }, []);

  const fieldsFrom = (task: TaskListing, source: TaskDetailFile | null): TaskFormInitial => ({
    directory: parentDirectory(catalogRelativePath(task.path, task.project_root)),
    goal: source?.goal ?? task.goal,
    ...(source?.context ? { context: source.context } : {}),
    ...(source?.constraints ? { constraints: source.constraints } : {}),
    ...(source?.checkout ? { checkout: source.checkout } : {}),
    ...(source?.repository ? { repository: source.repository } : {}),
    ...(source?.ref ? { ref: source.ref } : {}),
    ...(task.project_root ? { project_root: task.project_root } : {}),
  });

  const openEdit = useCallback(() => {
    if (!selectedTask) return;
    setDialog({
      mode: "edit",
      initial: { ...fieldsFrom(selectedTask, detail), id: selectedTask.id },
    });
  }, [selectedTask, detail]);

  const openDuplicate = useCallback(() => {
    if (!selectedTask) return;
    setDialog({
      mode: "duplicate",
      initial: { ...fieldsFrom(selectedTask, detail), id: `${selectedTask.id}-copy` },
    });
  }, [selectedTask, detail]);

  const closeDialog = useCallback(() => setDialog(null), []);

  const onSaved = useCallback(
    async (saved: TaskDetailFile, projectRoot?: string) => {
      setDialog(null);
      showToast(`Task saved · ${saved.id}`);
      setTab("all");
      setSearch("");
      const next = await load();
      const savedPath = catalogRelativePath(saved.path, projectRoot);
      const match =
        next.find(
          (t) =>
            t.id === saved.id &&
            catalogRelativePath(t.path, t.project_root) === savedPath,
        ) ?? next.find((t) => t.id === saved.id);
      if (match) {
        setSelectedKey(taskRowKey(match));
        navigate(taskPath(match.id));
      }
      setDetailVersion((v) => v + 1);
    },
    [load],
  );

  const selectedIndex = selected ? rows.findIndex((r) => r.key === selected.key) : -1;
  const dialogOpen = dialog !== null;

  useHotkeys(
    [
      {
        key: "j",
        scope: "tasks",
        when: () => !dialogOpen && rows.length > 0,
        handler: (e) => {
          e.preventDefault();
          selectRow(rows[Math.min(selectedIndex < 0 ? 0 : selectedIndex + 1, rows.length - 1)]!);
        },
      },
      {
        key: "k",
        scope: "tasks",
        when: () => !dialogOpen && rows.length > 0,
        handler: (e) => {
          e.preventDefault();
          selectRow(rows[Math.max(selectedIndex <= 0 ? 0 : selectedIndex - 1, 0)]!);
        },
      },
      {
        key: "enter",
        scope: "tasks",
        when: () => !dialogOpen && Boolean(selected?.last),
        handler: (e) => {
          const target = e.target instanceof HTMLElement ? e.target : null;
          if (target?.closest("button, a") && !target.closest("[data-task-row]")) return;
          e.preventDefault();
          if (selected?.last) navigate(runStreamPath(selected.last.run_id));
        },
      },
      {
        key: "s",
        scope: "tasks",
        when: () => !dialogOpen && Boolean(selected),
        handler: (e) => {
          e.preventDefault();
          startRun();
        },
      },
      {
        key: "n",
        scope: "tasks",
        when: () => !dialogOpen,
        handler: (e) => {
          e.preventDefault();
          openCreate();
        },
      },
      {
        key: "e",
        scope: "tasks",
        when: () => !dialogOpen && Boolean(selected),
        handler: (e) => {
          e.preventDefault();
          openEdit();
        },
      },
      {
        key: "/",
        scope: "tasks",
        when: () => !dialogOpen,
        handler: (e) => {
          e.preventDefault();
          searchRef.current?.focus();
        },
      },
    ],
    "tasks",
  );

  const loading = tasksLoading || catalogLoading;
  const displayError = error ?? catalogError;
  const folder = taskFolderLabel(tasks);
  const validationText = validationStatusLabel(validation, validatedAt, now);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex w-full h-14 shrink-0 justify-between items-center border-b px-5 py-0 gap-4 border-b-[#ffffff12]">
        <div className="flex shrink-0 items-baseline gap-2.5">
          <h1 className="text-[#ecedee] font-sans text-xl font-semibold leading-normal tracking-[-0.4px]">
            Tasks
          </h1>
          <span className={`text-[#8b8f98] ${MONO} text-[13px] leading-normal`}>{tasks.length}</span>
          <span className="flex items-center gap-[5px] self-center">
            <LuFolder className="size-3 block text-[#8b8f98]" aria-hidden />
            <span className={`text-[#8b8f98] ${MONO} text-xs leading-normal ${NOWRAP}`}>{folder}</span>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <label className="flex w-[280px] h-8 items-center bg-[#1a1c21] border border-[#ffffff1a] rounded-lg px-2.5 py-0 gap-2">
            <LuSearch className="size-3.5 block shrink-0 text-[#8b8f98]" aria-hidden />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  e.currentTarget.blur();
                }
              }}
              placeholder="Search tasks by id or goal"
              aria-label="Search tasks by id or goal"
              className="min-w-0 flex-1 bg-transparent text-[#ecedee] font-sans text-[13px] leading-normal outline-none placeholder:text-[#8b8f98]"
              spellCheck={false}
            />
            <span className={`bg-[#131418] border border-[#ffffff1a] text-[#8b8f98] ${MONO} text-[11px] leading-normal rounded-sm px-[5px] py-0`}>
              /
            </span>
          </label>
          <button type="button" onClick={openImport} className={`${SECONDARY_BTN} px-3 gap-2`}>
            <LuGithub className="size-3.5 block text-[#a7aab2]" aria-hidden />
            <span className={`text-[#ecedee] font-sans text-[13px] font-medium leading-normal ${NOWRAP}`}>
              Import from issue
            </span>
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="flex h-8 shrink-0 items-center bg-[#ecedee] rounded-lg px-3 py-0 gap-2"
          >
            <LuPlus className="size-3.5 block text-[#0c0d0f]" aria-hidden />
            <span className={`text-[#0c0d0f] font-sans text-[13px] font-medium leading-normal ${NOWRAP}`}>
              New task
            </span>
            <span className={KEYCAP_LIGHT}>N</span>
          </button>
        </div>
      </div>

      <div className="flex w-full h-12 shrink-0 justify-between items-center border-b px-5 py-0 border-b-[#ffffff12]">
        <div className="flex items-center gap-0.5">
          <FilterChip
            active={tab === "all"}
            label="All"
            onClick={() => setTab("all")}
            count={
              <span className={`${MONO} text-xs leading-normal ${tab === "all" ? "text-[#a7aab2]" : "text-[#8b8f98]"}`}>
                {counts.all}
              </span>
            }
          />
          <FilterChip
            active={tab === "has_open_gate"}
            label="Has open gate"
            onClick={() => setTab("has_open_gate")}
            icon={<LuHand className="size-[13px] block text-[#f5b544]" aria-hidden />}
            count={
              counts.has_open_gate > 0 ? (
                <span className={`bg-[#f5b544] shadow-[0px_0px_10px_rgba(245,181,68,0.45)] text-[#1a1306] ${MONO} text-[11px] font-semibold leading-normal rounded-full px-1.5 py-0`}>
                  {counts.has_open_gate}
                </span>
              ) : (
                <span className={`text-[#8b8f98] ${MONO} text-xs leading-normal`}>0</span>
              )
            }
          />
          <FilterChip
            active={tab === "failing"}
            label="Failing"
            onClick={() => setTab("failing")}
            icon={<LuX className="size-[13px] block text-[#f2645a]" aria-hidden />}
            count={
              <span className={`${MONO} text-xs leading-normal ${counts.failing > 0 ? "text-[#f2645a]" : "text-[#8b8f98]"}`}>
                {counts.failing}
              </span>
            }
          />
          <FilterChip
            active={tab === "no_runs"}
            label="Never run"
            onClick={() => setTab("no_runs")}
            icon={<LuCircleDashed className="size-[13px] block text-[#a7aab2]" aria-hidden />}
            count={
              <span className={`text-[#8b8f98] ${MONO} text-xs leading-normal`}>{counts.no_runs}</span>
            }
          />
        </div>
        <div className="flex h-[30px] items-center rounded-lg px-2.5 py-0 gap-1.5">
          <LuArrowUpDown className="size-[13px] block text-[#8b8f98]" aria-hidden />
          <span className={`text-[#8b8f98] font-sans text-[13px] leading-normal ${NOWRAP}`}>Sort:</span>
          <span className={`text-[#ecedee] font-sans text-[13px] leading-normal ${NOWRAP}`}>
            Needs attention
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-col border-r flex-1 border-r-[#ffffff12]">
          <TasksColumnHeader />
          <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
            {displayError ? (
              <p className="px-5 py-3 text-xs text-[#f2645a]">{displayError}</p>
            ) : null}
            {loading && tasks.length === 0 ? (
              <p className="px-5 py-3 text-xs text-[#8b8f98]">Loading tasks…</p>
            ) : null}
            {!loading && tasks.length === 0 && !displayError ? (
              <p className="px-5 py-3 text-xs text-[#8b8f98]">No tasks in this catalog.</p>
            ) : null}
            {tasks.length > 0 && rows.length === 0 ? (
              <p className="px-5 py-3 text-xs text-[#8b8f98]">No tasks match this filter.</p>
            ) : null}
            {rows.map((row) => (
              <TasksTableRow
                key={row.key}
                row={row}
                selected={selected?.key === row.key}
                rootLabel={showRoots ? rootBasename(row.task.project_root) : undefined}
                onSelect={() => selectRow(row)}
              />
            ))}
          </div>
        </div>

        <aside className="flex w-[440px] min-w-0 min-h-0 flex-col shrink-0 bg-[#131418] overflow-clip">
          {selected ? (
            <TaskInspector
              key={selected.key}
              row={selected}
              detail={detail}
              detailLoading={detailLoading}
              onEdit={openEdit}
              onStartRun={startRun}
              onDuplicate={openDuplicate}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[#8b8f98] font-sans text-[13px] leading-normal">
              Select a task
            </div>
          )}
        </aside>
      </div>

      <div className="flex w-full h-8 shrink-0 items-center bg-[#08090a] border-t px-5 py-0 gap-4 border-t-[#ffffff12]">
        <FooterHint keys={["J", "K"]} label="move" />
        <FooterDot />
        <FooterHint keys={["Enter"]} label="open" />
        <FooterDot />
        <FooterHint keys={["S"]} label="start run" />
        <FooterDot />
        <FooterHint keys={["N"]} label="new task" />
        <div className="block flex-1" />
        <div className={`text-[#8b8f98] ${MONO} text-[11px] leading-normal ${NOWRAP}`}>
          {`${tasks.length} ${tasks.length === 1 ? "file" : "files"} in ${folder}`}
          {validationText ? ` · ${validationText}` : ""}
        </div>
      </div>

      <TaskFormDialog
        open={dialogOpen}
        mode={dialog?.mode ?? "create"}
        initial={dialog?.initial ?? null}
        onClose={closeDialog}
        onSaved={(task, root) => void onSaved(task, root)}
      />
    </div>
  );
}
