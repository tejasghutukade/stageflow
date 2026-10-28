import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown, LuSearch } from "react-icons/lu";
import { textFieldKeepsKey } from "../../keys";
import { edgeEnabled, filterPickerOptions, modelPickerOptions, nextEnabled, type PickerOption } from "./runDialogModel";
import type { SwitcherTone } from "./runSwitcherModel";

const MONO = "font-['Geist_Mono',monospace]";
const TONE_COLOR: Record<SwitcherTone, string> = {
  ok: "var(--sf-ok)",
  fail: "var(--sf-fail)",
  running: "var(--sf-running)",
  muted: "var(--sf-text-3)",
};

/** A themed single-choice dropdown: optional search, grouped rows, keyboard navigation. */
export function RunPicker({
  ariaLabel,
  value,
  options,
  onChange,
  searchable = false,
  hint,
  compact = false,
}: {
  ariaLabel: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  hint?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = useMemo(() => filterPickerOptions(options, query), [options, query]);
  const current = options.find((o) => o.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 340), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const up = below < 260 && above > below;
    setAnchor({
      position: "fixed",
      left,
      width,
      maxHeight: Math.max(160, Math.min(360, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const start = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(start >= 0 ? start : Math.max(0, edgeEnabled(options, "first")));
    (searchable ? searchRef.current : listRef.current)?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) setActive(Math.max(0, edgeEnabled(shown, "first")));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(option: PickerOption | undefined) {
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      close();
    } else if (textFieldKeepsKey(event)) {
      return;
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => nextEnabled(shown, a, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => nextEnabled(shown, a, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(Math.max(0, edgeEnabled(shown, "first")));
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, edgeEnabled(shown, "last")));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  let lastGroup: string | undefined;

  return (
    <div ref={rootRef} className={compact ? "relative inline-block min-w-0 max-w-full" : "relative block"}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex ${compact ? "h-[30px]" : "h-[34px] w-full"} min-w-0 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-ground)] px-3 text-left text-[13px] text-[var(--sf-text-1)] outline-none hover:border-[#ffffff33] focus-visible:border-[var(--sf-running)]`}
      >
        <span className={`min-w-0 flex-1 truncate ${MONO}`}>
          {current?.label ?? ""}
          {current && !current.isDefault && current.group ? <span className="text-[var(--sf-text-3)]"> · {current.group}</span> : null}
          {current && !current.group && current.sublabel ? <span className="text-[var(--sf-text-3)]"> · {current.sublabel}</span> : null}
        </span>
        <LuChevronDown className="size-3.5 shrink-0 text-[var(--sf-text-2)]" aria-hidden />
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={popoverRef}
              style={anchor}
              onKeyDown={onKeyDown}
              className="z-[300] flex flex-col overflow-hidden rounded-[10px] border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] shadow-[0px_12px_32px_rgba(0,0,0,0.45)]"
            >
              {searchable ? (
                <div className="flex items-center gap-2 border-b border-[var(--sf-hairline)] px-3">
                  <LuSearch aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" />
                  <input
                    ref={searchRef}
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                    aria-label={`Search ${ariaLabel}`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models"
                    className={`h-9 min-w-0 flex-1 bg-transparent ${MONO} text-xs text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]`}
                  />
                </div>
              ) : null}
              <div
                ref={listRef}
                id={listId}
                role="listbox"
                tabIndex={searchable ? -1 : 0}
                aria-label={ariaLabel}
                aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
              >
                {shown.length === 0 ? <div className="px-3 py-2 text-xs text-[var(--sf-text-3)]">No matches.</div> : null}
                {shown.map((option, index) => {
                  const heading = option.group && option.group !== lastGroup ? option.group : null;
                  lastGroup = option.group;
                  const selected = option.value === value;
                  return (
                    <div key={option.value || "__default"}>
                      {heading ? (
                        <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[var(--sf-text-3)]">
                          {heading}
                        </div>
                      ) : null}
                      <div
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={option.disabled ? true : undefined}
                        title={option.reason ?? option.value}
                        onMouseMove={() => !option.disabled && setActive(index)}
                        onClick={() => choose(option)}
                        className={`flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1 text-left ${
                          option.disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"
                        } ${index === active && !option.disabled ? "bg-[var(--sf-active)]" : ""}`}
                      >
                        <span className="flex size-3 shrink-0 items-center justify-center">
                          {selected ? <LuCheck aria-hidden className="size-3 text-[var(--sf-text-1)]" /> : null}
                        </span>
                        <span className={`min-w-0 shrink-0 truncate text-xs text-[var(--sf-text-1)] ${option.group ? "" : MONO}`}>{option.label}</span>
                        {option.chip ? (
                          <span className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: TONE_COLOR[option.chip.tone] }}>
                            <span className="block size-1.5 rounded-full" style={{ background: TONE_COLOR[option.chip.tone] }} />
                            {option.chip.text}
                          </span>
                        ) : null}
                        {option.meta ? <span className={`${MONO} shrink-0 text-xs text-[var(--sf-text-2)]`}>{option.meta}</span> : null}
                        {option.sublabel ? (
                          <span className={`min-w-0 flex-1 truncate text-[11px] text-[var(--sf-text-3)] ${option.group ? MONO : ""}`}>{option.sublabel}</span>
                        ) : (
                          <span className="flex-1" />
                        )}
                        {option.isDefault && selected ? <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">current</span> : null}
                        {option.disabled && option.reason ? <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">{option.reason.split(".")[0]}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
              {hint ? <div className="border-t border-[var(--sf-hairline)] px-3 py-1.5 text-[11px] text-[var(--sf-text-3)]">{hint}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** The judge field: the same searchable, grouped picker as the agent model. */
export function JudgeModelPicker({
  models,
  value,
  defaultLabel,
  onChange,
  ariaLabel = "Judge model",
}: {
  models: ReadonlyArray<{ id: string; provider?: string; name?: string; judge_capable?: boolean }>;
  value: string | null;
  defaultLabel: string;
  onChange: (value: string | null) => void;
  ariaLabel?: string;
}) {
  return (
    <RunPicker
      searchable
      ariaLabel={ariaLabel}
      value={value ?? ""}
      options={modelPickerOptions([...models], defaultLabel, true)}
      onChange={(next) => onChange(next === "" ? null : next)}
    />
  );
}
