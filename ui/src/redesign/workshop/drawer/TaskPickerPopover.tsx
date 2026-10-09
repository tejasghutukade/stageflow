import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LuClipboardList, LuSearch } from "react-icons/lu";
import { filterTasks, type WorkshopTaskOption } from "./drawerModel";

export type TaskPickerPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>;
  tasks: WorkshopTaskOption[];
  loading?: boolean;
  onPick: (task: WorkshopTaskOption) => void;
  onClose: () => void;
};

const WIDTH = 340;
const MAX_HEIGHT = 300;

type Placement = { left: number; top?: number; bottom?: number };

function computePlacement(anchor: HTMLElement): Placement {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  if (rect.top > MAX_HEIGHT + 16 || rect.top > window.innerHeight - rect.bottom) {
    return { left, bottom: window.innerHeight - rect.top + 6 };
  }
  return { left, top: rect.bottom + 6 };
}

export function TaskPickerPopover({
  anchorRef,
  tasks,
  loading,
  onPick,
  onClose,
}: TaskPickerPopoverProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const filtered = useMemo(() => filterTasks(tasks, query), [query, tasks]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const update = () => setPlacement(computePlacement(anchor));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchorRef]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!placement) return null;

  const emptyText = loading
    ? "Loading tasks…"
    : tasks.length === 0
      ? "No tasks in the catalog"
      : "No tasks match";

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Attach existing task"
      style={{ left: placement.left, top: placement.top, bottom: placement.bottom, width: WIDTH }}
      className="fixed z-[70] flex max-h-[300px] flex-col overflow-clip rounded-[10px] border border-[#ffffff1a] bg-[#1a1c21] font-sans shadow-[0px_16px_48px_rgba(0,0,0,0.55)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((index) => Math.min(filtered.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter") {
          const task = filtered[active];
          if (task) {
            event.preventDefault();
            onPick(task);
          }
        }
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-3">
        <LuSearch className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter tasks…"
          aria-label="Filter tasks"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[#ecedee] outline-none placeholder:text-[#8b8f98]"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-3 text-xs text-[#8b8f98]">{emptyText}</div>
      ) : (
        <ul role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.map((task, index) => (
            <li key={task.path} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(task)}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                  index === active ? "bg-[#ffffff0a]" : ""
                }`}
              >
                <LuClipboardList className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-['Geist_Mono',monospace] text-xs text-[#ecedee]">
                    {task.id}
                  </span>
                  <span className="truncate font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
                    {task.path}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
