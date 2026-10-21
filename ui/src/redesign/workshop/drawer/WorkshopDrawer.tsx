import type { ReactNode } from "react";
import { LuChevronDown, LuChevronUp, LuListChecks, LuX } from "react-icons/lu";
import type { ValidationFinding } from "../../../api";
import { useNow, type TimeInput } from "../relativeTime";
import { ChangesTab } from "./ChangesTab";
import { ProblemsTab } from "./ProblemsTab";
import { TaskTab } from "./TaskTab";
import {
  problemsBadge,
  taskTabSuffix,
  validatedMeta,
  type WorkshopDrawerTab,
  type WorkshopDrawerTask,
  type WorkshopMutationCard,
  type WorkshopTaskOption,
} from "./drawerModel";

export type WorkshopDrawerProps = {
  tab: WorkshopDrawerTab;
  onTabChange: (tab: WorkshopDrawerTab) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  task: WorkshopDrawerTask | null;
  tasks: WorkshopTaskOption[];
  tasksLoading?: boolean;
  onAttachTask: (task: WorkshopTaskOption) => void;
  onCreateTask: () => void;
  onDetachTask: () => void;
  findings: ValidationFinding[] | null;
  validatedAt: TimeInput | null;
  validateBusy: boolean;
  validateError?: string | null;
  onAskFix: (finding: ValidationFinding) => void;
  onGoToField: (finding: ValidationFinding) => void;
  mutationCards: ReadonlyMap<string, WorkshopMutationCard>;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
};

const MONO = "font-['Geist_Mono',monospace]";

function DrawerTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`group/tab flex items-center gap-[5px] border-b-2 ${
        active ? "border-b-[#ecedee]" : "border-b-transparent"
      }`}
    >
      {children}
    </button>
  );
}

function tabLabelClass(active: boolean): string {
  return `whitespace-nowrap font-sans text-xs ${
    active ? "font-medium text-[#ecedee]" : "text-[#a7aab2] group-hover/tab:text-[#ecedee]"
  }`;
}

export function WorkshopDrawer({
  tab,
  onTabChange,
  collapsed,
  onCollapsedChange,
  task,
  tasks,
  tasksLoading,
  onAttachTask,
  onCreateTask,
  onDetachTask,
  findings,
  validatedAt,
  validateBusy,
  validateError,
  onAskFix,
  onGoToField,
  mutationCards,
  onAccept,
  onReject,
}: WorkshopDrawerProps) {
  const now = useNow(5000, validatedAt !== null);
  const meta = validatedMeta(validatedAt, validateBusy, now);
  const badge = problemsBadge(findings);
  const taskSuffix = taskTabSuffix(task);

  const select = (next: WorkshopDrawerTab) => {
    onTabChange(next);
    if (collapsed) onCollapsedChange(false);
  };

  const active = (id: WorkshopDrawerTab) => !collapsed && tab === id;

  return (
    <section
      aria-label="Draft details"
      className={`flex w-full min-w-0 shrink-0 flex-col border-t border-t-[#ffffff12] bg-[#131418] ${
        collapsed ? "h-[35px]" : "h-[200px]"
      }`}
    >
      <div
        role="tablist"
        className={`flex h-[34px] w-full shrink-0 gap-4 border-b px-3.5 ${
          collapsed ? "border-b-transparent" : "border-b-[#ffffff12]"
        }`}
      >
        <DrawerTabButton active={active("task")} onClick={() => select("task")}>
          <LuListChecks
            className={`size-3 ${active("task") ? "text-[#ecedee]" : "text-[#8b8f98]"}`}
            aria-hidden
          />
          <span className={tabLabelClass(active("task"))}>Task</span>
          {taskSuffix ? (
            <span className={`max-w-[200px] truncate ${MONO} text-[11px] text-[#8b8f98]`}>{taskSuffix}</span>
          ) : null}
        </DrawerTabButton>
        <DrawerTabButton active={active("problems")} onClick={() => select("problems")}>
          <span className={tabLabelClass(active("problems"))}>Problems</span>
          {badge.kind === "errors" ? (
            <span className="flex h-4 items-center gap-0.5 rounded-sm bg-[#f2645a1f] px-1">
              <LuX className="size-2.5 text-[#f2645a]" aria-hidden />
              <span className={`${MONO} text-[11px] font-medium text-[#f2645a]`}>{badge.label}</span>
            </span>
          ) : (
            <span className={`${MONO} text-[11px] text-[#8b8f98]`}>{badge.label}</span>
          )}
        </DrawerTabButton>
        <DrawerTabButton active={active("changes")} onClick={() => select("changes")}>
          <span className={tabLabelClass(active("changes"))}>Changes</span>
          <span className={`${MONO} text-[11px] text-[#8b8f98]`}>{mutationCards.size}</span>
        </DrawerTabButton>
        <div className="min-w-0 flex-1" />
        <div className="flex items-center gap-2">
          {meta ? (
            <span className={`whitespace-nowrap ${MONO} text-[11px] text-[#8b8f98]`}>{meta}</span>
          ) : null}
          <button
            type="button"
            aria-label={collapsed ? "Expand panel" : "Collapse panel"}
            aria-expanded={!collapsed}
            onClick={() => onCollapsedChange(!collapsed)}
            className="flex size-[22px] items-center justify-center rounded-md hover:bg-[#ffffff0a]"
          >
            {collapsed ? (
              <LuChevronUp className="size-[13px] text-[#8b8f98]" aria-hidden />
            ) : (
              <LuChevronDown className="size-[13px] text-[#8b8f98]" aria-hidden />
            )}
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
          {tab === "task" ? (
            <TaskTab
              task={task}
              tasks={tasks}
              tasksLoading={tasksLoading}
              onAttachTask={onAttachTask}
              onCreateTask={onCreateTask}
              onDetachTask={onDetachTask}
            />
          ) : tab === "problems" ? (
            <ProblemsTab
              findings={findings}
              validateBusy={validateBusy}
              validateError={validateError}
              onAskFix={onAskFix}
              onGoToField={onGoToField}
            />
          ) : (
            <ChangesTab mutationCards={mutationCards} onAccept={onAccept} onReject={onReject} />
          )}
        </div>
      )}
    </section>
  );
}
