import { useMemo, useState, type ReactNode } from "react";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuCrosshair,
  LuInfo,
  LuLoaderCircle,
  LuSparkles,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import type { ValidationFinding } from "../../../api";
import {
  findingKey,
  findingLocation,
  findingSeverity,
  messageSegments,
  sortFindings,
} from "./drawerModel";

export type ProblemsTabProps = {
  findings: ValidationFinding[] | null;
  validateBusy: boolean;
  validateError?: string | null;
  onAskFix: (finding: ValidationFinding) => void;
  onGoToField: (finding: ValidationFinding) => void;
};

const MONO = "font-['Geist_Mono',monospace]";

function Message({ text, className }: { text: string; className: string }) {
  return (
    <>
      {messageSegments(text).map((segment, index) =>
        segment.code ? (
          <span key={index} className={`${MONO} text-xs`}>
            {segment.text}
          </span>
        ) : (
          <span key={index} className={className}>
            {segment.text}
          </span>
        ),
      )}
    </>
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 px-3.5 py-2.5">{children}</div>;
}

function GoToFieldButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-[7px] hover:bg-[#202228]"
    >
      <LuCrosshair className="size-3 text-[#ecedee]" aria-hidden />
      <span className="whitespace-nowrap font-sans text-xs text-[#ecedee]">Go to field</span>
    </button>
  );
}

export function ProblemsTab({
  findings,
  validateBusy,
  validateError,
  onAskFix,
  onGoToField,
}: ProblemsTabProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const sorted = useMemo(() => (findings ? sortFindings(findings) : []), [findings]);
  const wide = sorted.some((finding) => findingSeverity(finding) === "warning");
  const severityWidth = wide ? "w-[72px]" : "w-14";
  const messageIndent = wide ? "pl-[82px]" : "pl-[66px]";

  if (validateError) {
    return (
      <StatusLine>
        <LuCircleAlert className="size-3.5 shrink-0 text-[#f2645a]" aria-hidden />
        <span className="font-sans text-xs text-[#f2645a]">Validation could not run: {validateError}</span>
      </StatusLine>
    );
  }

  if (findings === null) {
    return (
      <StatusLine>
        {validateBusy ? (
          <>
            <LuLoaderCircle className="size-3.5 animate-spin text-[#a7aab2]" aria-hidden />
            <span className="font-sans text-xs text-[#a7aab2]">Validating…</span>
          </>
        ) : (
          <span className="font-sans text-xs text-[#8b8f98]">
            Not validated yet. Press V or click Validate to check this draft.
          </span>
        )}
      </StatusLine>
    );
  }

  if (sorted.length === 0) {
    return (
      <StatusLine>
        {validateBusy ? (
          <LuLoaderCircle className="size-3.5 animate-spin text-[#a7aab2]" aria-hidden />
        ) : (
          <LuCircleCheck className="size-3.5 text-[#4cc38a]" aria-hidden />
        )}
        <span className="font-sans text-xs text-[#a7aab2]">No problems</span>
      </StatusLine>
    );
  }

  return (
    <div className={`flex w-full flex-col py-1.5${validateBusy ? " opacity-60" : ""}`}>
      {sorted.map((finding, index) => {
        const key = findingKey(finding, index);
        const selected = key === selectedKey;
        const severity = findingSeverity(finding);
        const location = findingLocation(finding);
        const select = () => setSelectedKey(key);

        if (severity === "error") {
          return (
            <div
              key={key}
              onClick={select}
              className={`flex w-full flex-col gap-[3px] border-l-2 px-3.5 py-[7px] ${
                selected ? "border-l-[#f2645a] bg-[#ffffff08]" : "border-l-transparent hover:bg-[#ffffff05]"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div className={`flex ${severityWidth} shrink-0 items-center gap-[5px]`}>
                  <LuX className="size-[13px] text-[#f2645a]" aria-hidden />
                  <span className="font-sans text-xs font-medium text-[#f2645a]">error</span>
                </div>
                <span
                  className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[#ecedee]`}
                  title={location}
                >
                  {location}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onAskFix(finding);
                  }}
                  className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-md px-1.5 hover:bg-[#ffffff0a]"
                >
                  <LuSparkles className="size-3 text-[#a7aab2]" aria-hidden />
                  <span className="whitespace-nowrap font-sans text-xs font-medium text-[#a7aab2]">
                    Ask agent to fix
                  </span>
                </button>
                <GoToFieldButton onClick={() => onGoToField(finding)} />
              </div>
              <div className={`${messageIndent} text-[13px] leading-[1.45] text-[#ecedee]`}>
                <Message text={finding.message} className="font-sans text-[13px]" />
              </div>
            </div>
          );
        }

        const warning = severity === "warning";
        return (
          <div
            key={key}
            onClick={select}
            title={finding.message}
            className={`group flex h-[30px] w-full items-center gap-2.5 border-l-2 px-3.5 ${
              selected
                ? `${warning ? "border-l-[#a7aab2]" : "border-l-[#8b8f98]"} bg-[#ffffff08]`
                : "border-l-transparent hover:bg-[#ffffff05]"
            }`}
          >
            <div className={`flex ${severityWidth} shrink-0 items-center gap-[5px]`}>
              {warning ? (
                <LuTriangleAlert className="size-[13px] text-[#a7aab2]" aria-hidden />
              ) : (
                <LuInfo className="size-[13px] text-[#8b8f98]" aria-hidden />
              )}
              <span className="font-sans text-xs text-[#a7aab2]">{severity}</span>
            </div>
            <span className={`max-w-[40%] shrink-0 truncate ${MONO} text-xs text-[#8b8f98]`}>
              {location}
            </span>
            <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[#a7aab2]">
              <Message text={finding.message} className="font-sans text-[13px]" />
            </span>
            <div className={selected ? "flex" : "hidden group-hover:flex"}>
              <GoToFieldButton onClick={() => onGoToField(finding)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
