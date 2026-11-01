import { useState, type ReactNode } from "react";
import { LuCheck, LuCopy, LuTriangleAlert } from "react-icons/lu";
import type { IdentityAuditEvent, IdentityConnection } from "../../api/identity";
import {
  FAILED_TEST_COPY,
  PREVIEW_COPY,
  absoluteTime,
  errorCopy,
  identityConnectionLines,
  oidcActivateReady,
  previewWord,
  reasonLabel,
  relativeTime,
  type Tone,
} from "./identityView";

export const MONO = "[font-family:'Geist_Mono',_monospace]";
export const NOWRAP = "[white-space-collapse:collapse] [text-wrap-mode:nowrap]";
export const INPUT =
  "h-9 w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73]";
export const PRIMARY =
  "inline-flex h-8 items-center justify-center gap-2 rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-50";
export const SECONDARY =
  "inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee] hover:bg-[#22252b] disabled:opacity-50";
export const GHOST =
  "inline-flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-[13px] text-[#a7aab2] hover:bg-[#1a1c21] hover:text-[#ecedee] disabled:opacity-50";
export const DANGER =
  "inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-[#f2645a47] bg-[#f2645a1f] px-3 text-[13px] font-medium text-[#f2645a] hover:bg-[#f2645a33] disabled:opacity-50";
export const CARD = "rounded-lg border border-[#ffffff12] bg-[#131418]";
export const TILE = "flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21]";
export const EYEBROW = `text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase ${NOWRAP}`;

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-[#4cc38a]",
  needs: "bg-[#f5b544]",
  fail: "bg-[#f2645a]",
  muted: "bg-[#8b8f98]",
};

export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden />;
}

export function StatusLabel({ tone, label, detail }: { tone: Tone; label: string; detail?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-[6px]"><StatusDot tone={tone} /></span>
      <div className="flex min-w-0 flex-col">
        <span className={`text-[13px] leading-normal ${tone === "muted" ? "text-[#a7aab2]" : "text-[#ecedee]"}`}>{label}</span>
        {detail ? <span className="text-xs leading-[1.4] text-[#8b8f98]">{detail}</span> : null}
      </div>
    </div>
  );
}

export function Tag({ children, tone = "muted", mono = false }: { children: ReactNode; tone?: Tone; mono?: boolean }) {
  const color = tone === "ok" ? "border-[#4cc38a47] bg-[#4cc38a1f] text-[#4cc38a]"
    : tone === "needs" ? "border-[#f5b54447] bg-[#f5b5441f] text-[#f5b544]"
      : tone === "fail" ? "border-[#f2645a47] bg-[#f2645a1f] text-[#f2645a]"
        : "border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]";
  return (
    <span className={`inline-flex items-center rounded-[4px] border px-1.5 text-[11px] leading-[18px] ${color} ${NOWRAP}${mono ? ` ${MONO}` : ""}`}>
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5${className ? ` ${className}` : ""}`}>
      <span className="text-[13px] font-medium leading-normal text-[#ecedee]">{label}</span>
      {children}
      {error ? <span className="text-xs leading-[1.4] text-[#f2645a]">{error}</span> : null}
      {!error && hint ? <span className="text-xs leading-[1.4] text-[#8b8f98]">{hint}</span> : null}
    </label>
  );
}

export function SectionHead({ title, subtitle, aside }: { title: string; subtitle?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-[15px] font-semibold leading-normal text-[#ecedee]">{title}</h2>
        {subtitle ? <p className="text-[13px] leading-normal text-[#a7aab2]">{subtitle}</p> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className={`${CARD} flex flex-col items-center gap-2 px-6 py-10 text-center`}>
      <div className={TILE}>{icon}</div>
      <h3 className="text-[15px] font-semibold leading-normal text-[#ecedee]">{title}</h3>
      {children ? <div className="flex max-w-[520px] flex-col items-center gap-3 text-[13px] leading-[1.5] text-[#a7aab2]">{children}</div> : null}
    </div>
  );
}

export function IdentityError({ code }: { code: string }) {
  const copy = errorCopy(code);
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-[#f2645a47] bg-[#f2645a14] px-3 py-2.5 text-[13px] text-[#f2645a]"
      role="alert"
    >
      <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>{copy.title}</span>
        {copy.hint ? <span className="text-xs text-[#a7aab2]">{copy.hint}</span> : null}
        <span className={`text-[11px] text-[#8b8f98] ${MONO}`}>{copy.code}</span>
      </div>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[#ffffff1a] px-2 text-xs text-[#a7aab2] hover:bg-[#1a1c21]"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <LuCheck className="block size-3 text-[#4cc38a]" aria-hidden /> : <LuCopy className="block size-3" aria-hidden />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function IdentityConnectionFacts({ connection }: { connection: IdentityConnection }) {
  return (
    <dl className="flex flex-col gap-2.5">
      {identityConnectionLines(connection).map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-[#8b8f98]">{line.label}</dt>
          <dd
            className={`min-w-0 whitespace-pre-wrap break-words text-right text-[13px] text-[#ecedee] ${line.label === "Issuer" || line.label === "Callback" ? MONO : ""}`}
            data-testid={line.label === "Upstream note" ? "upstream-note" : undefined}
          >
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function IdentityPreviewNotice() {
  return <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{PREVIEW_COPY}</p>;
}

export function IdentityPreviewResult({ outcome }: { outcome: "allow" | "deny" }) {
  const allowed = outcome === "allow";
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${allowed ? "border-[#4cc38a47] bg-[#4cc38a14]" : "border-[#f2645a47] bg-[#f2645a14]"}`}
      role="status"
    >
      <span className="mt-[7px]"><StatusDot tone={allowed ? "ok" : "fail"} /></span>
      <div className="flex flex-col gap-0.5">
        <p className={`text-[15px] font-semibold ${allowed ? "text-[#4cc38a]" : "text-[#f2645a]"}`} data-testid="identity-preview-result">
          {previewWord(outcome)}
        </p>
        <p className="text-[13px] text-[#a7aab2]">
          {allowed ? "This person could read that order." : "This person could not read that order."}
        </p>
      </div>
    </div>
  );
}

function StepNumber({ state, index }: { state: "done" | "current" | "todo"; index: number }) {
  if (state === "done") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#4cc38a1f] text-[#4cc38a]">
        <LuCheck className="block size-3" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${MONO} ${state === "current" ? "border-[#6ca6ff] text-[#6ca6ff]" : "border-[#ffffff1a] text-[#8b8f98]"}`}
    >
      {index}
    </span>
  );
}

export function OidcDraftActions({
  recordedTest,
  prepared = false,
  live = false,
  busy,
  onPrepare,
  onRecordTest,
  onActivate,
}: {
  recordedTest: boolean;
  prepared?: boolean;
  live?: boolean;
  busy: boolean;
  onPrepare: () => void;
  onRecordTest: () => void;
  onActivate: () => void;
}) {
  const preparedState = prepared || recordedTest || live ? "done" : "current";
  const testState = recordedTest || live ? "done" : preparedState === "done" ? "current" : "todo";
  const activateState = live ? "done" : testState === "done" ? "current" : "todo";
  return (
    <ol className="flex flex-col">
      <li className="flex gap-3 pb-4">
        <StepNumber state={preparedState} index={1} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-[#ecedee]">Check the provider</span>
          <span className="text-xs leading-[1.5] text-[#8b8f98]">Stageflow reads the issuer&apos;s discovery document and keys.</span>
          <div>
            <button type="button" className={SECONDARY} onClick={onPrepare} disabled={busy}>
              {preparedState === "done" ? "Check again" : "Check provider"}
            </button>
          </div>
        </div>
      </li>
      <li className="flex gap-3 pb-4">
        <StepNumber state={testState} index={2} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-[#ecedee]">Try a test sign-in</span>
          <span className="text-xs leading-[1.5] text-[#8b8f98]">
            Sign in once through the provider yourself, then record that it worked.
          </span>
          <div>
            <button type="button" className={SECONDARY} onClick={onRecordTest} disabled={busy}>
              Record test sign-in
            </button>
          </div>
        </div>
      </li>
      <li className="flex gap-3">
        <StepNumber state={activateState} index={3} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-[#ecedee]">Go live</span>
          <span className="text-xs leading-[1.5] text-[#8b8f98]">{FAILED_TEST_COPY}</span>
          <div>
            <button
              type="button"
              className={PRIMARY}
              data-action="activate-oidc"
              onClick={onActivate}
              disabled={!oidcActivateReady(recordedTest) || busy || live}
            >
              {live ? "Live" : "Activate"}
            </button>
          </div>
        </div>
      </li>
    </ol>
  );
}

export function IdentityAuditTable({
  events,
  now = Date.now(),
  people = {},
}: {
  events: readonly IdentityAuditEvent[];
  now?: number;
  /** Principal id to the sign-in name the operator recognises. */
  people?: Readonly<Record<string, string>>;
}) {
  return (
    <table className="w-full border-collapse text-left text-[13px] text-[#ecedee]">
      <thead>
        <tr className={EYEBROW}>
          <th className="px-4 py-2.5 font-medium">When</th>
          <th className="px-4 py-2.5 font-medium">Outcome</th>
          <th className="px-4 py-2.5 font-medium">What happened</th>
          <th className="px-4 py-2.5 font-medium">Person</th>
          <th className="px-4 py-2.5 font-medium">Conversation</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => {
          const denied = event.outcome === "deny";
          return (
            <tr key={`${event.at}:${event.principalId}:${index}`} className="border-t border-[#ffffff12]">
              <td className="px-4 py-2.5 text-xs text-[#a7aab2]" title={absoluteTime(event.at)}>
                {relativeTime(event.at, now)}
              </td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-2">
                  <StatusDot tone={denied ? "fail" : "ok"} />
                  <span className={denied ? "text-[#f2645a]" : "text-[#ecedee]"}>{denied ? "Denied" : "Allowed"}</span>
                  <span className="sr-only">{event.outcome}</span>
                </span>
              </td>
              <td className="px-4 py-2.5">
                <div className="flex flex-col">
                  <span>{reasonLabel(event.reason)}</span>
                  <span className={`text-[11px] text-[#8b8f98] ${MONO}`}>{event.reason}</span>
                </div>
              </td>
              <td className={`px-4 py-2.5 text-xs ${MONO} ${event.principalId ? "text-[#ecedee]" : "text-[#8b8f98]"}`}>
                {event.principalId ? (people[event.principalId] ?? event.principalId) : "Operator"}
              </td>
              <td className={`px-4 py-2.5 text-xs ${MONO} ${event.conversationId ? "text-[#ecedee]" : "text-[#8b8f98]"}`}>
                {event.conversationId || "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
