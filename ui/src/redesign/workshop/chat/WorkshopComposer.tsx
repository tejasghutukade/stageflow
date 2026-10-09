import { useAui, useAuiState } from "@assistant-ui/react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import {
  LuArrowUp,
  LuCheck,
  LuChevronDown,
  LuCpu,
  LuFile,
  LuInfo,
  LuPaperclip,
  LuSquare,
  LuX,
} from "react-icons/lu";
import { maySend } from "../../../workshop/workshopChatView";
import {
  ATTACHMENT_ACCEPT,
  formatBytes,
  mediaTypeFor,
  planAttachmentAdds,
  textContentLooksBinary,
  userMessageCustom,
  type WorkshopChatAttachment,
} from "./attachments";
import { modelTail } from "./changeCardModel";

export type WorkshopComposerHandle = {
  prefill(text: string): void;
  focus(): void;
  send(text: string): void;
};

export type WorkshopComposerProps = {
  emptyThread: boolean;
  models: readonly string[];
  model: string | null;
  defaultModel: string | null;
  onModelChange: (model: string) => void;
  hasTask: boolean;
  attachments: readonly WorkshopChatAttachment[];
  onAttachmentsChange: (next: WorkshopChatAttachment[]) => void;
  docsContext: boolean;
  onDocsContextChange: (next: boolean) => void;
  onStop?: () => void;
  handleRef?: Ref<WorkshopComposerHandle>;
};

const MONO = "font-['Geist_Mono',monospace]";
const CHIP = `flex h-5 shrink-0 items-center rounded-sm border px-1.5 ${MONO} text-[11px] leading-normal`;
const TEXTAREA_MAX_HEIGHT = 200;

function ModelMenu({
  models,
  model,
  defaultModel,
  onModelChange,
}: {
  models: readonly string[];
  model: string | null;
  defaultModel: string | null;
  onModelChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = model ?? defaultModel ?? "";
  const base = models.length > 0 ? [...models] : defaultModel ? [defaultModel] : [];
  const options = current && !base.includes(current) ? [current, ...base] : base;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Workshop chat model"
        title={current}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 min-w-0 items-center gap-[5px] rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-[7px] hover:border-[#ffffff33]"
      >
        <LuCpu aria-hidden className="size-3 shrink-0 text-[#8b8f98]" />
        <span className={`min-w-0 truncate ${MONO} text-[11px] leading-normal text-[#ecedee]`}>
          {current ? modelTail(current) : "model"}
        </span>
        <LuChevronDown aria-hidden className="size-3 shrink-0 text-[#8b8f98]" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Workshop chat model"
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 flex max-h-[280px] w-[320px] flex-col overflow-auto rounded-[10px] border border-[#ffffff1a] bg-[#131418] py-1 shadow-[0px_12px_32px_rgba(0,0,0,0.45)]"
        >
          {options.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-[#8b8f98]">No models available</div>
          ) : (
            options.map((id) => {
              const selected = id === current;
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onModelChange(id);
                    setOpen(false);
                  }}
                  className={`flex h-7 min-w-0 items-center gap-2 px-3 text-left hover:bg-[#1a1c21] ${selected ? "bg-[#1a1c21]" : ""}`}
                >
                  <span className="flex size-3 shrink-0 items-center justify-center">
                    {selected ? <LuCheck aria-hidden className="size-3 text-[#ecedee]" /> : null}
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${MONO} text-xs leading-normal text-[#ecedee]`}>
                    {id}
                  </span>
                  {id === defaultModel ? (
                    <span className="shrink-0 text-[11px] leading-normal text-[#8b8f98]">default</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export function WorkshopComposer({
  emptyThread,
  models,
  model,
  defaultModel,
  onModelChange,
  hasTask,
  attachments,
  onAttachmentsChange,
  docsContext,
  onDocsContextChange,
  onStop,
  handleRef,
}: WorkshopComposerProps) {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [text, setText] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const docsRef = useRef(docsContext);
  const runningRef = useRef(isRunning);
  attachmentsRef.current = attachments;
  docsRef.current = docsContext;
  runningRef.current = isRunning;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  const appendTurn = (value: string, files: readonly WorkshopChatAttachment[]): boolean => {
    if (runningRef.current || !maySend(value)) return false;
    aui.thread().append({
      role: "user",
      content: [{ type: "text", text: value }],
      metadata: { custom: userMessageCustom(files, docsRef.current) },
    });
    return true;
  };

  const submit = () => {
    const files = attachmentsRef.current;
    if (!appendTurn(text, files)) return;
    setText("");
    setAttachError(null);
    if (files.length > 0) onAttachmentsChange([]);
  };

  const focusEnd = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  };

  useImperativeHandle(
    handleRef,
    () => ({
      prefill(value: string) {
        setText(value);
        requestAnimationFrame(focusEnd);
      },
      focus() {
        focusEnd();
      },
      send(value: string) {
        appendTurn(value, []);
      },
    }),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length === 0) return;
    const plan = planAttachmentAdds(attachmentsRef.current, picked);
    const errors = [...plan.errors];
    const read: WorkshopChatAttachment[] = [];
    for (const file of plan.accepted) {
      try {
        const content = await file.text();
        if (textContentLooksBinary(content)) {
          errors.push(`${file.name} is not a text file`);
          continue;
        }
        read.push({ name: file.name, mediaType: mediaTypeFor(file), size: file.size, content });
      } catch {
        errors.push(`Could not read ${file.name}`);
      }
    }
    setAttachError(errors.length > 0 ? errors.join(" · ") : null);
    if (read.length > 0) onAttachmentsChange([...attachmentsRef.current, ...read]);
  };

  const removeAttachment = (name: string) => {
    setAttachError(null);
    onAttachmentsChange(attachmentsRef.current.filter((item) => item.name !== name));
  };

  const sendable = !isRunning && maySend(text);
  const placeholder = emptyThread ? "Describe the workflow you want…" : "Ask Workshop Author…";
  const current = model ?? defaultModel;

  return (
    <div className="flex w-full shrink-0 flex-col gap-1.5 border-t border-t-[#ffffff12] px-3 pb-3 pt-2.5">
      <div className="flex flex-col rounded-[10px] border border-[#ffffff1a] bg-[#131418] focus-within:border-[#ffffff33] focus-within:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]">
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
          <button
            type="button"
            aria-label="Attach files"
            title="Attach text files (up to 5, 256 KB each)"
            onClick={() => fileInputRef.current?.click()}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff0a] hover:text-[#ecedee]"
          >
            <LuPaperclip aria-hidden className="size-[13px]" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            tabIndex={-1}
            onChange={(event) => void onFiles(event)}
          />
          <span title="The current draft is always in context" className={`${CHIP} border-[#ffffff1a] bg-[#1a1c21] text-[#ecedee]`}>
            @draft
          </span>
          {hasTask ? (
            <span title="The attached task is in context" className={`${CHIP} border-[#ffffff1a] bg-[#1a1c21] text-[#ecedee]`}>
              @task
            </span>
          ) : null}
          <button
            type="button"
            aria-pressed={docsContext}
            title={docsContext ? "Stageflow YAML reference is in context" : "Add the Stageflow YAML reference to context"}
            onClick={() => onDocsContextChange(!docsContext)}
            className={`${CHIP} ${docsContext ? "border-[#ffffff1a] bg-[#1a1c21] text-[#ecedee]" : "border-dashed border-[#ffffff24] text-[#a7aab2] hover:text-[#ecedee]"}`}
          >
            @docs
          </button>
          {attachments.map((file) => (
            <span
              key={file.name}
              title={`${file.name} · ${formatBytes(file.size)}`}
              className={`${CHIP} max-w-[180px] gap-1 border-[#ffffff1a] bg-[#1a1c21] pr-0.5 text-[#ecedee]`}
            >
              <LuFile aria-hidden className="size-3 shrink-0 text-[#8b8f98]" />
              <span className="min-w-0 truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => removeAttachment(file.name)}
                className="flex size-4 shrink-0 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff14] hover:text-[#ecedee]"
              >
                <LuX aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
        {attachError ? (
          <div role="alert" className="px-2.5 pt-1.5 text-[11px] leading-normal text-[#f2645a]">
            {attachError}
          </div>
        ) : null}
        <div className="flex min-h-10 px-2.5 pt-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label="Message Workshop Author"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            className="w-full resize-none border-0 bg-transparent p-0 font-sans text-[13px] leading-normal text-[#ecedee] outline-none placeholder:text-[#8b8f98]"
          />
        </div>
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <ModelMenu
            models={models}
            model={model}
            defaultModel={defaultModel}
            onModelChange={onModelChange}
          />
          {current && current === defaultModel ? (
            <span className="whitespace-nowrap text-[11px] leading-normal text-[#8b8f98]">
              Workshop default
            </span>
          ) : null}
          <span className="flex-1" />
          {isRunning ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={() => onStop?.()}
              className="flex size-[26px] shrink-0 items-center justify-center rounded-md bg-[#ecedee]"
            >
              <LuSquare aria-hidden className="size-3 fill-[#0c0d0f] text-[#0c0d0f]" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!sendable}
              onClick={submit}
              className={`flex size-[26px] shrink-0 items-center justify-center rounded-md ${sendable ? "bg-[#ecedee] text-[#0c0d0f]" : "cursor-not-allowed bg-[#2a2d33] text-[#8b8f98]"}`}
            >
              <LuArrowUp aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-[5px] px-0.5">
        <LuInfo aria-hidden className="size-3 shrink-0 text-[#8b8f98]" />
        <span className="min-w-0 flex-1 truncate text-[11px] leading-normal text-[#8b8f98]">
          Edits apply to the draft, not disk
        </span>
        <span className={`rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
          ↵
        </span>
        <span className="text-[11px] leading-normal text-[#8b8f98]">send</span>
        <span className={`ml-1 rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
          ⇧↵
        </span>
        <span className="text-[11px] leading-normal text-[#8b8f98]">newline</span>
      </div>
    </div>
  );
}
