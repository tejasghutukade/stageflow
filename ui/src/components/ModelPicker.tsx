import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown, LuCpu, LuRefreshCw, LuSearch, LuTriangleAlert } from "react-icons/lu";
import { filterModelGroups, formatContextWindow, isKnownModel, modelTail } from "../modelCatalog/modelCatalog";
import { useModelCatalog } from "../modelCatalog/useModelCatalog";

const MONO = "font-['Geist_Mono',monospace]";

export type ModelPickerProps = {
  /** The chosen id, or null when the screen inherits one. */
  value: string | null;
  onChange: (value: string | null) => void;
  ariaLabel: string;
  /** `field` fills a form row; `chip` is the compact control in the Workshop composer. */
  variant?: "field" | "chip";
  placement?: "down" | "up";
  /** Adds an option that clears the choice, e.g. "Inherit from pipeline". */
  inheritLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Overrides the catalog default shown as "default" in the list. */
  defaultModel?: string | null;
  /** A validation finding sits on this field. */
  error?: boolean;
  /** Briefly highlights the field when a problem links to it. */
  flash?: boolean;
  /** Show the inline "not in connected providers" note. Off where the screen already reports it. */
  warnUnknown?: boolean;
  /** Lets a screen focus the control, e.g. when a problem links to it. */
  triggerRef?: Ref<HTMLButtonElement>;
  className?: string;
};

/**
 * The model control for every screen: models of connected providers, grouped, searchable, with a
 * custom-id escape hatch. An id no connected provider lists is accepted and flagged, never refused.
 */
export function ModelPicker({
  value,
  onChange,
  ariaLabel,
  variant = "field",
  placement = "down",
  inheritLabel,
  placeholder = "Select a model",
  disabled = false,
  defaultModel,
  error = false,
  flash = false,
  warnUnknown = true,
  triggerRef,
  className = "",
}: ModelPickerProps) {
  const { status, catalog, error: loadError, refreshing, refresh } = useModelCatalog();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const providers = catalog?.providers ?? [];
  // With no inherit option the value in effect is the catalog default, so show it as chosen.
  const explicit = value !== null && value.trim() !== "" ? value : null;
  const defaultId = defaultModel ?? catalog?.default ?? null;
  const chosen = explicit ?? (inheritLabel ? null : defaultId);
  const known = chosen === null || isKnownModel(catalog, chosen);
  const result = useMemo(() => filterModelGroups(providers, query), [providers, query]);
  const nothingConnected = status === "ready" && providers.length === 0;

  // The popover is portalled and fixed to the trigger so a clipping parent (a narrow inspector) cannot cut it off.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const up = placement === "up" ? above >= 200 || above > below : below < 240 && above > below;
    setAnchor({
      position: "fixed",
      left,
      width,
      maxHeight: Math.max(160, Math.min(340, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    searchRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function choose(next: string | null) {
    onChange(next);
    setOpen(false);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = result.groups[0]?.models[0];
    if (first) choose(first.id);
    else if (result.customId) choose(result.customId);
  }

  const label = chosen ?? inheritLabel ?? placeholder;
  const tone = flash
    ? "border-[var(--sf-running)] shadow-[0px_0px_0px_3px_rgba(108,166,255,0.18)]"
    : error
      ? "border-[var(--sf-fail)]"
      : "border-[var(--sf-hairline-strong)] hover:border-[#ffffff33]";
  const trigger =
    variant === "chip"
      ? `flex h-6 min-w-0 items-center gap-[5px] rounded-md border bg-[var(--sf-raised)] px-[7px] disabled:opacity-50 ${tone}`
      : `flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-lg border bg-[var(--sf-raised)] px-2.5 transition-[border-color,box-shadow] duration-300 disabled:opacity-50 ${tone}`;
  const popover = "z-[300] flex flex-col overflow-hidden rounded-[10px] border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] shadow-[0px_12px_32px_rgba(0,0,0,0.45)]";

  return (
    <div ref={rootRef} className={`relative min-w-0 ${variant === "field" ? "w-full" : "flex items-center"} ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={known ? (chosen ?? undefined) : `${chosen} is not listed by a connected provider`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={trigger}
      >
        <LuCpu aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" />
        <span className={`min-w-0 flex-1 truncate text-left ${MONO} text-[11px] leading-normal ${chosen ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}>
          {variant === "chip" && chosen ? modelTail(chosen) : label}
        </span>
        {!known ? <LuTriangleAlert aria-label="Not in connected providers" className="size-3 shrink-0 text-[var(--sf-needs)]" /> : null}
        <LuChevronDown aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" />
      </button>

      {!known && warnUnknown && variant === "field" ? (
        <p role="note" className="mt-1 text-xs leading-normal text-[var(--sf-needs)]">
          Not in connected providers. It is still used as written.
        </p>
      ) : null}

      {open && anchor
        ? createPortal(
        <div ref={popoverRef} style={anchor} className={popover}>
          <div className="flex items-center gap-2 border-b border-[var(--sf-hairline)] px-3">
            <LuSearch aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" />
            <input
              ref={searchRef}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-label="Search models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Search or type provider/model"
              className={`h-9 min-w-0 flex-1 bg-transparent ${MONO} text-xs text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]`}
            />
            <button
              type="button"
              aria-label="Refresh models from providers"
              title="Ask connected providers for their current models"
              disabled={refreshing}
              onClick={() => void refresh()}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-text-1)] disabled:opacity-50"
            >
              <LuRefreshCw aria-hidden className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div id={listId} role="listbox" aria-label={ariaLabel} className="min-h-0 flex-1 overflow-auto py-1">
            {inheritLabel && query.trim() === "" ? (
              <Row selected={chosen === null} onPick={() => choose(null)}>
                <span className="text-xs text-[var(--sf-text-2)]">{inheritLabel}</span>
              </Row>
            ) : null}

            {status === "loading" ? <Note>Loading models…</Note> : null}
            {status === "error" ? <Note tone="fail">Couldn't load models{loadError ? `: ${loadError}` : ""}</Note> : null}
            {nothingConnected ? (
              <Note>
                No connected providers.{" "}
                <a href="#/settings" className="text-[var(--sf-running)] underline-offset-2 hover:underline" onClick={() => setOpen(false)}>
                  Connect one in Providers
                </a>{" "}
                to choose from its models, or type a provider/model id above.
              </Note>
            ) : null}

            {result.groups.map(({ provider, models }) => (
              <div key={provider.id} role="group" aria-label={provider.name}>
                <div className="flex items-center gap-2 px-3 pb-0.5 pt-2 text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[var(--sf-text-3)]">
                  <span>{provider.name}</span>
                  {provider.source === "fallback" ? (
                    <span title={provider.error} className="normal-case tracking-normal text-[var(--sf-needs)]">
                      built-in list
                    </span>
                  ) : null}
                </div>
                {models.map((model) => {
                  const context = formatContextWindow(model.contextWindow);
                  return (
                    <Row key={model.id} selected={model.id === chosen} onPick={() => choose(model.id)} title={model.id}>
                      <span className={`min-w-0 flex-1 truncate ${MONO} text-xs leading-normal text-[var(--sf-text-1)]`}>{modelTail(model.id)}</span>
                      {model.free ? <Badge>free</Badge> : null}
                      {context ? <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">{context}</span> : null}
                      {model.id === defaultId ? <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">default</span> : null}
                    </Row>
                  );
                })}
              </div>
            ))}

            {result.shown < result.total ? (
              <Note>
                Showing {result.shown} of {result.total}. Keep typing to narrow.
              </Note>
            ) : null}
            {status === "ready" && !nothingConnected && result.total === 0 && !result.customId && query.trim() !== "" ? <Note>No models match.</Note> : null}

            {result.customId ? (
              <Row selected={false} onPick={() => choose(result.customId)}>
                <span className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[var(--sf-text-1)]`}>Use “{result.customId}”</span>
                <span className="shrink-0 text-[11px] text-[var(--sf-needs)]">not in connected providers</span>
              </Row>
            ) : null}
          </div>
        </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function Row({ selected, onPick, title, children }: { selected: boolean; onPick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      title={title}
      onClick={onPick}
      className={`flex h-7 w-full min-w-0 items-center gap-2 px-3 text-left hover:bg-[var(--sf-raised)] ${selected ? "bg-[var(--sf-raised)]" : ""}`}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">{selected ? <LuCheck aria-hidden className="size-3 text-[var(--sf-text-1)]" /> : null}</span>
      {children}
    </button>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded-sm bg-[var(--sf-ok-bg)] px-1 text-[10px] leading-4 text-[var(--sf-ok)]">{children}</span>;
}

function Note({ children, tone }: { children: ReactNode; tone?: "fail" }) {
  return <div className={`px-3 py-1.5 text-xs leading-normal ${tone === "fail" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`}>{children}</div>;
}
