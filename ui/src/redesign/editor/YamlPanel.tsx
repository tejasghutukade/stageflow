import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";
import { LuCircleX, LuFileCode, LuLightbulb, LuTriangleAlert, LuX } from "react-icons/lu";
import type { DraftPackagePayload } from "../../api";
import { draftFileYaml, findingLineForFile, normalizeYamlPath } from "./draftYaml";
import {
  YAML_LINE_HEIGHT,
  applyYamlEdit,
  centerLineScrollTop,
  cursorLineCol,
  findingTokenIndex,
  isPipelineYamlPath,
  isYamlPathDirty,
  revealColumnScrollLeft,
  revealLineScrollTop,
  stageEntryLineRange,
  yamlEditChangesDraft,
  yamlFooterCounts,
  yamlLineTop,
  yamlTabLabel,
  yamlTabPaths,
  yamlTextMatchesDraft,
  type YamlEditError,
  type YamlLineRange,
  type YamlParseError,
} from "./yamlEditorModel";
import { highlightYaml, type YamlToken } from "./yamlHighlight";

export type YamlPanelFinding = {
  path: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning";
  code?: string;
  message: string;
  quickFixLabel?: string;
};

export type YamlPanelProps = {
  draft: DraftPackagePayload | null;
  pipelinePath: string | null;
  activePath?: string | null;
  onActivePathChange?: (path: string) => void;
  openPaths?: string[];
  onClosePath?: (path: string) => void;
  dirtyPaths?: ReadonlySet<string>;
  highlightRange?: YamlLineRange | null;
  selectedStageId?: string | null;
  activeFinding?: YamlPanelFinding | null;
  onQuickFix?: () => void;
  onDraftChange?: (next: DraftPackagePayload) => void;
  onParseError?: (error: YamlParseError | null) => void;
  formatNonce?: number;
  readOnly?: boolean;
};

type LocalYaml = { path: string; text: string; error: YamlEditError | null };

const GUTTER_WIDTH = 40;

const EMPTY_DIRTY: ReadonlySet<string> = new Set();

const TOKEN_CLASS: Record<YamlToken["kind"], string> = {
  plain: "text-[#ecedee]",
  key: "text-[#a7aab2]",
  punct: "text-[#8b8f98]",
  string: "text-[#8fc7a8]",
  comment: "text-[#8b8f98]",
};

const CODE_FONT =
  "font-['Geist_Mono',monospace] text-xs leading-5 tracking-normal [font-variant-ligatures:none] [tab-size:2]";

function withoutKeys(
  entries: Record<string, LocalYaml>,
  drop: (key: string, entry: LocalYaml) => boolean,
): Record<string, LocalYaml> {
  let changed = false;
  const next: Record<string, LocalYaml> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (drop(key, entry)) changed = true;
    else next[key] = entry;
  }
  return changed ? next : entries;
}

export function YamlPanel({
  draft,
  pipelinePath,
  activePath,
  onActivePathChange,
  openPaths,
  onClosePath,
  dirtyPaths = EMPTY_DIRTY,
  highlightRange,
  selectedStageId = null,
  activeFinding = null,
  onQuickFix,
  onDraftChange,
  onParseError,
  formatNonce = 0,
  readOnly,
}: YamlPanelProps) {
  const editable = !(readOnly ?? !onDraftChange);
  const [internalPath, setInternalPath] = useState<string | null>(null);
  const selectedPath = activePath ?? internalPath ?? pipelinePath;
  const activeKey = selectedPath ? normalizeYamlPath(selectedPath) : "";
  const onPipelineTab = isPipelineYamlPath(selectedPath, pipelinePath);

  const tabPaths = useMemo(
    () => (pipelinePath ? yamlTabPaths(pipelinePath, [...(openPaths ?? []), selectedPath]) : []),
    [pipelinePath, openPaths, selectedPath],
  );
  const tabKeys = tabPaths.map(normalizeYamlPath).join("\n");

  const [entries, setEntries] = useState<Record<string, LocalYaml>>({});
  const [cursor, setCursor] = useState({ key: "", line: 1, column: 1 });
  const scrollerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const formatRef = useRef(formatNonce);
  const reportedRef = useRef("");

  const canonical = useMemo(
    () => (draft && selectedPath ? draftFileYaml(draft, selectedPath, pipelinePath) : ""),
    [draft, selectedPath, pipelinePath],
  );
  const text = entries[activeKey]?.text ?? canonical;
  const rows = text.split("\n");
  const highlighted = useMemo(() => highlightYaml(text), [text]);

  useEffect(() => {
    if (!draft) return;
    setEntries((prev) =>
      withoutKeys(
        prev,
        (_key, entry) =>
          entry.error === null &&
          !yamlTextMatchesDraft(draft, entry.path, pipelinePath, entry.text),
      ),
    );
  }, [draft, pipelinePath]);

  useEffect(() => {
    const open = new Set(tabKeys.split("\n"));
    setEntries((prev) => withoutKeys(prev, (key) => !open.has(key)));
  }, [tabKeys]);

  useEffect(() => {
    if (formatRef.current === formatNonce) return;
    formatRef.current = formatNonce;
    setEntries((prev) =>
      withoutKeys(prev, (key, entry) => key === activeKey && entry.error === null),
    );
  }, [formatNonce, activeKey]);

  const parseError = useMemo((): YamlParseError | null => {
    const active = entries[activeKey];
    const errored = active?.error
      ? active
      : Object.values(entries).find((entry) => entry.error !== null);
    return errored?.error ? { path: errored.path, ...errored.error } : null;
  }, [entries, activeKey]);
  const parseErrorKey = parseError ? JSON.stringify(parseError) : "";

  useEffect(() => {
    if (reportedRef.current === parseErrorKey) return;
    reportedRef.current = parseErrorKey;
    onParseError?.(parseError);
  }, [parseErrorKey, parseError, onParseError]);

  const rawFindingLine = findingLineForFile(activeFinding, selectedPath);
  const findingLine =
    rawFindingLine !== undefined && rawFindingLine <= rows.length ? rawFindingLine : undefined;
  const findingSeverity = activeFinding?.severity ?? "warning";
  const quickFixLabel =
    findingLine !== undefined && onQuickFix ? activeFinding?.quickFixLabel : undefined;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || findingLine === undefined) return;
    el.scrollTop = centerLineScrollTop(findingLine, el.clientHeight);
  }, [findingLine, activeKey]);

  const range = !onPipelineTab
    ? null
    : highlightRange !== undefined
      ? highlightRange
      : selectedStageId
        ? stageEntryLineRange(text, selectedStageId)
        : null;

  const cursorLabel =
    cursor.key === activeKey ? `Ln ${cursor.line}, Col ${cursor.column}` : "Ln 1, Col 1";

  function pickTab(path: string) {
    if (onActivePathChange) onActivePathChange(path);
    else setInternalPath(path);
  }

  function closeTab(path: string) {
    if (pipelinePath && selectedPath && normalizeYamlPath(path) === activeKey) {
      pickTab(pipelinePath);
    }
    onClosePath?.(path);
  }

  function handleChange(next: string) {
    if (!editable || !draft || !selectedPath) return;
    const result = applyYamlEdit(draft, selectedPath, pipelinePath, next);
    setEntries((prev) => ({
      ...prev,
      [activeKey]: { path: selectedPath, text: next, error: result.ok ? null : result.error },
    }));
    if (result.ok && yamlEditChangesDraft(draft, result.draft)) onDraftChange?.(result.draft);
  }

  function caretOf(el: HTMLTextAreaElement) {
    const offset = el.selectionDirection === "backward" ? el.selectionStart : el.selectionEnd;
    return cursorLineCol(el.value, offset);
  }

  function handleSelect(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { line, column } = caretOf(event.currentTarget);
    setCursor({ key: activeKey, line, column });
  }

  function revealCaret(el: HTMLTextAreaElement) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { line, column } = caretOf(el);
    const charWidth = (measureRef.current?.getBoundingClientRect().width ?? 72) / 10;
    scroller.scrollTop = revealLineScrollTop(line, scroller.scrollTop, scroller.clientHeight);
    scroller.scrollLeft = revealColumnScrollLeft(
      column,
      charWidth,
      GUTTER_WIDTH,
      scroller.scrollLeft,
      scroller.clientWidth,
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === ".") {
      if (quickFixLabel && onQuickFix) {
        event.preventDefault();
        onQuickFix();
      }
      return;
    }
    if (
      event.key !== "Tab" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !editable
    ) {
      return;
    }
    event.preventDefault();
    const el = event.currentTarget;
    if (document.execCommand("insertText", false, "  ")) return;
    const start = el.selectionStart;
    const next = `${el.value.slice(0, start)}  ${el.value.slice(el.selectionEnd)}`;
    handleChange(next);
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
  }

  function resetInnerScroll(event: SyntheticEvent<HTMLTextAreaElement>) {
    event.currentTarget.scrollTop = 0;
    event.currentTarget.scrollLeft = 0;
  }

  if (!pipelinePath) {
    return (
      <div className="flex w-[400px] shrink-0 flex-col border-r border-r-[#ffffff12] bg-[#131418]">
        <p className="p-3 text-xs text-[#8b8f98]">YAML unavailable</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-[400px] shrink-0 flex-col border-r border-r-[#ffffff12] bg-[#131418]">
      <div
        className="flex h-9 w-full shrink-0 items-end gap-0.5 overflow-x-auto border-b border-b-[#ffffff12] px-2 [scrollbar-width:none]"
        role="tablist"
      >
        {tabPaths.map((path) => {
          const active = normalizeYamlPath(path) === activeKey;
          const pipelineTab = isPipelineYamlPath(path, pipelinePath);
          const dirty = isYamlPathDirty(dirtyPaths, path);
          const label = yamlTabLabel(path, pipelinePath);
          return (
            <div
              key={normalizeYamlPath(path)}
              className={`flex h-[30px] shrink-0 items-center gap-1.5 px-2.5${
                active ? " rounded-t-md bg-[#1a1c21]" : ""
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={path}
                className={`flex items-center gap-1.5 border-0 bg-transparent p-0 font-['Geist_Mono',monospace] text-xs leading-[1.33333] whitespace-nowrap${
                  active ? " text-[#ecedee]" : " text-[#a7aab2] hover:text-[#ecedee]"
                }`}
                onClick={() => pickTab(path)}
              >
                <LuFileCode
                  aria-hidden
                  className={`size-3 shrink-0 ${active ? "text-[#a7aab2]" : "text-[#8b8f98]"}`}
                />
                {label}
                {dirty ? (
                  <span
                    aria-label="Unsaved changes"
                    className="size-1.5 shrink-0 rounded-full bg-[#ecedee]"
                  />
                ) : null}
              </button>
              {pipelineTab ? null : (
                <button
                  type="button"
                  aria-label="Close tab"
                  className="flex size-[11px] items-center justify-center rounded-sm border-0 bg-transparent p-0 text-[#8b8f98] hover:text-[#ecedee]"
                  onClick={() => closeTab(path)}
                >
                  <LuX aria-hidden className="size-[11px]" />
                </button>
              )}
            </div>
          );
        })}
        <div className="flex-1" />
      </div>
      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className={`relative min-h-full w-max min-w-full py-2.5 ${CODE_FONT}`}>
          <span
            ref={measureRef}
            aria-hidden
            className="pointer-events-none invisible absolute top-0 left-0 whitespace-pre"
          >
            0000000000
          </span>
          {rows.map((_row, index) => {
            const lineNumber = index + 1;
            const tokens = highlighted[index] ?? [];
            const isFinding = findingLine === lineNumber;
            const inRange =
              range != null && lineNumber >= range.start && lineNumber <= range.end;
            const markIndex = isFinding ? findingTokenIndex(tokens, activeFinding?.column) : -1;
            return (
              <div
                key={lineNumber}
                data-yaml-line={lineNumber}
                className={`flex h-5 items-center pr-6${
                  isFinding
                    ? " border-l-2 border-l-[#a7aab2] bg-[#ffffff0f]"
                    : inRange
                      ? " bg-[#ffffff06]"
                      : ""
                }`}
              >
                {isFinding ? (
                  <span className="flex w-[38px] shrink-0 items-center justify-end gap-[3px] pr-3.5 select-none">
                    {findingSeverity === "error" ? (
                      <LuCircleX aria-hidden className="size-[11px] shrink-0 text-[#e5484d]" />
                    ) : (
                      <LuTriangleAlert
                        aria-hidden
                        className="size-[11px] shrink-0 text-[#a7aab2]"
                      />
                    )}
                    <span className="text-[#ecedee]">{lineNumber}</span>
                  </span>
                ) : (
                  <span
                    className={`w-10 shrink-0 pr-3.5 text-right select-none ${
                      inRange ? "text-[#a7aab2]" : "text-[#8b8f98]"
                    }`}
                  >
                    {lineNumber}
                  </span>
                )}
                <span className="whitespace-pre">
                  {tokens.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className={`${TOKEN_CLASS[token.kind]}${
                        tokenIndex === markIndex
                          ? " underline decoration-[#a7aab2] decoration-wavy underline-offset-4"
                          : ""
                      }`}
                    >
                      {token.text}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
          <textarea
            aria-label="YAML source"
            value={text}
            readOnly={!editable}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            className={`absolute top-0 right-0 bottom-0 left-10 z-[1] m-0 block resize-none appearance-none overflow-hidden border-0 bg-transparent px-0 py-2.5 whitespace-pre text-transparent caret-[#ecedee] outline-none selection:bg-[#ffffff1f] ${CODE_FONT}`}
            onChange={(event) => {
              handleChange(event.target.value);
              handleSelect(event);
            }}
            onSelect={handleSelect}
            onMouseUp={handleSelect}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => {
              handleSelect(event);
              revealCaret(event.currentTarget);
            }}
            onScroll={resetInnerScroll}
          />
          {findingLine !== undefined && activeFinding ? (
            <div
              className="absolute right-3 left-10 z-[2] mt-1 flex max-w-[348px] flex-col gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] p-2.5 font-sans shadow-[0px_8px_24px_rgba(0,0,0,0.45)]"
              style={{ top: yamlLineTop(findingLine) + YAML_LINE_HEIGHT }}
              role="status"
            >
              <div className="flex items-center gap-1.5">
                {findingSeverity === "error" ? (
                  <LuCircleX aria-hidden className="size-[13px] shrink-0 text-[#e5484d]" />
                ) : (
                  <LuTriangleAlert aria-hidden className="size-[13px] shrink-0 text-[#a7aab2]" />
                )}
                <span className="text-xs leading-[1.66667] font-medium text-[#ecedee]">
                  {findingSeverity === "error" ? "Error" : "Warning"}
                </span>
                {activeFinding.code ? (
                  <span className="font-['Geist_Mono',monospace] text-[11px] leading-[1.81818] text-[#8b8f98]">
                    {activeFinding.code}
                  </span>
                ) : null}
              </div>
              <p className="m-0 text-xs leading-[1.41667] whitespace-normal text-[#a7aab2]">
                {activeFinding.message}
              </p>
              {quickFixLabel ? (
                <button
                  type="button"
                  className="flex items-center gap-1.5 self-start rounded-sm border-0 bg-transparent p-0 text-left hover:opacity-80"
                  onClick={() => onQuickFix?.()}
                >
                  <LuLightbulb aria-hidden className="size-3 shrink-0 text-[#ecedee]" />
                  <span className="text-xs leading-[1.66667] font-medium text-[#ecedee]">
                    {quickFixLabel}
                  </span>
                  <span className="rounded-sm border border-[#ffffff1a] bg-[#131418] px-[5px] font-['Geist_Mono',monospace] text-[11px] leading-[1.45455] text-[#8b8f98]">
                    ⌘.
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <footer className="flex h-[30px] w-full shrink-0 items-center gap-3 border-t border-t-[#ffffff12] px-3 font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#8b8f98]">
        <span>{cursorLabel}</span>
        <span>Spaces: 2</span>
        <span className="flex-1" />
        <span>{yamlFooterCounts(text, draft?.pipeline.stages.length ?? 0)}</span>
      </footer>
    </div>
  );
}
