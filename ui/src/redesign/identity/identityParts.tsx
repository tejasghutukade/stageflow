import type { IdentityAuditEvent, IdentityConnection } from "../../api/identity";
import { LuTriangleAlert } from "react-icons/lu";
import { FAILED_TEST_COPY, PREVIEW_COPY, identityConnectionLines, oidcActivateReady, previewWord } from "./identityView";

export const INPUT =
  "h-9 w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73]";
export const PRIMARY =
  "h-8 rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-60";
export const SECONDARY =
  "h-8 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee] disabled:opacity-60";
export const CARD = "rounded-lg border border-[#ffffff12] bg-[#131418]";
export const EYEBROW =
  "text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase";
const MONO = "[font-family:'Geist_Mono',_monospace]";

export function IdentityError({ code }: { code: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-[#f2645a]" role="alert">
      <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {code}
    </div>
  );
}

export function IdentityConnectionFacts({ connection }: { connection: IdentityConnection }) {
  return (
    <dl className="flex flex-col gap-2.5">
      {identityConnectionLines(connection).map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-3">
          <dt className="text-xs text-[#8b8f98]">{line.label}</dt>
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
  return (
    <p className="text-[15px] font-semibold text-[#ecedee]" data-testid="identity-preview-result">
      {previewWord(outcome)}
    </p>
  );
}

export function OidcDraftActions({
  recordedTest,
  busy,
  onPrepare,
  onRecordTest,
  onActivate,
}: {
  recordedTest: boolean;
  busy: boolean;
  onPrepare: () => void;
  onRecordTest: () => void;
  onActivate: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SECONDARY} onClick={onPrepare} disabled={busy}>
          Prepare
        </button>
        <button type="button" className={SECONDARY} onClick={onRecordTest} disabled={busy}>
          Record test sign-in
        </button>
        <button
          type="button"
          className={PRIMARY}
          data-action="activate-oidc"
          onClick={onActivate}
          disabled={!oidcActivateReady(recordedTest) || busy}
        >
          Activate
        </button>
      </div>
      <p className="text-[13px] leading-[1.5] text-[#a7aab2]">{FAILED_TEST_COPY}</p>
    </div>
  );
}

export function IdentityAuditTable({ events }: { events: readonly IdentityAuditEvent[] }) {
  return (
    <table className="w-full border-collapse text-left text-[13px] text-[#ecedee]">
      <thead>
        <tr className="text-xs text-[#8b8f98]">
          <th className="px-2 py-2 font-medium">At</th>
          <th className="px-2 py-2 font-medium">Principal</th>
          <th className="px-2 py-2 font-medium">Conversation</th>
          <th className="px-2 py-2 font-medium">Outcome</th>
          <th className="px-2 py-2 font-medium">Reason</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => (
          <tr key={`${event.at}:${event.principalId}:${index}`} className="border-t border-[#ffffff12]">
            <td className={`px-2 py-2 ${MONO}`}>{event.at}</td>
            <td className={`px-2 py-2 ${MONO}`}>{event.principalId}</td>
            <td className={`px-2 py-2 ${MONO}`}>{event.conversationId}</td>
            <td className="px-2 py-2">{event.outcome}</td>
            <td className="px-2 py-2">{event.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
