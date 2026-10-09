import { useMemo, useRef, useState } from "react";
import { LuCirclePlus, LuClipboardList, LuLink2, LuReplace, LuUnlink } from "react-icons/lu";
import { TaskPickerPopover } from "./TaskPickerPopover";
import {
  taskFieldRows,
  type WorkshopDrawerTask,
  type WorkshopTaskOption,
} from "./drawerModel";

export type TaskTabProps = {
  task: WorkshopDrawerTask | null;
  tasks: WorkshopTaskOption[];
  tasksLoading?: boolean;
  onAttachTask: (task: WorkshopTaskOption) => void;
  onCreateTask: () => void;
  onDetachTask: () => void;
};

const MONO = "font-['Geist_Mono',monospace]";

export function TaskTab({
  task,
  tasks,
  tasksLoading,
  onAttachTask,
  onCreateTask,
  onDetachTask,
}: TaskTabProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const attachRef = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => (task ? taskFieldRows(task.body) : []), [task]);

  const pick = (option: WorkshopTaskOption) => {
    setPickerOpen(false);
    onAttachTask(option);
  };

  const picker = pickerOpen ? (
    <TaskPickerPopover
      anchorRef={task ? replaceRef : attachRef}
      tasks={tasks}
      loading={tasksLoading}
      onPick={pick}
      onClose={() => setPickerOpen(false)}
    />
  ) : null;

  if (!task) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6">
        <div className="flex size-9 items-center justify-center rounded-[10px] border border-dashed border-[#ffffff26]">
          <LuClipboardList className="size-4 text-[#8b8f98]" aria-hidden />
        </div>
        <div className="flex max-w-[360px] flex-col items-center gap-1">
          <span className="font-sans text-[13px] font-medium text-[#ecedee]">No task attached</span>
          <span className="text-center font-sans text-xs leading-[1.45] text-[#8b8f98]">
            Pipelines save fine without one; attach a task to run right after saving.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            ref={attachRef}
            type="button"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
            className="flex h-8 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 hover:bg-[#202228]"
          >
            <LuLink2 className="size-3.5 text-[#ecedee]" aria-hidden />
            <span className="whitespace-nowrap font-sans text-[13px] font-medium text-[#ecedee]">
              Attach existing task
            </span>
          </button>
          <button
            type="button"
            onClick={onCreateTask}
            className="flex h-8 items-center gap-2 rounded-lg px-3 hover:bg-[#ffffff0a]"
          >
            <LuCirclePlus className="size-3.5 text-[#a7aab2]" aria-hidden />
            <span className="whitespace-nowrap font-sans text-[13px] font-medium text-[#a7aab2]">
              Create task
            </span>
          </button>
        </div>
        {picker}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-b-[#ffffff0d] px-3.5 py-2">
        <LuClipboardList className="size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate ${MONO} text-xs text-[#ecedee]`} title={task.filename}>
            {task.filename}
          </span>
          <span className={`truncate ${MONO} text-[11px] text-[#8b8f98]`} title={task.path ?? undefined}>
            {task.path ?? "attached to draft · not on disk"}
          </span>
        </div>
        <button
          ref={replaceRef}
          type="button"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
          className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 hover:bg-[#ffffff0a]"
        >
          <LuReplace className="size-3.5 text-[#a7aab2]" aria-hidden />
          <span className="font-sans text-xs font-medium text-[#a7aab2]">Replace</span>
        </button>
        <button
          type="button"
          onClick={onDetachTask}
          className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 hover:bg-[#ffffff0a]"
        >
          <LuUnlink className="size-3.5 text-[#a7aab2]" aria-hidden />
          <span className="font-sans text-xs font-medium text-[#a7aab2]">Detach</span>
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="px-3.5 py-2.5 font-sans text-xs text-[#8b8f98]">This task has no fields.</p>
      ) : (
        <dl className="flex flex-col py-1.5">
          {rows.map((row) => (
            <div key={row.key} className="flex h-6 items-center gap-3 px-3.5">
              <dt className={`w-32 shrink-0 truncate ${MONO} text-xs text-[#8b8f98]`}>{row.key}</dt>
              <dd className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[#ecedee]`} title={row.value}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {picker}
    </div>
  );
}
