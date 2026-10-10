import { LuCheck, LuLoaderCircle, LuX } from "react-icons/lu";
import type { WorkshopToolActivityRow } from "../../../workshop/workshopChatView";
import { isMutationTool, toolResultView } from "./changeCardModel";

const MONO = "font-['Geist_Mono',monospace]";

export function WorkshopToolCallGroup({
  calls,
}: {
  calls: readonly WorkshopToolActivityRow[];
}) {
  if (calls.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-[#ffffff12]">
      {calls.map((call, index) => {
        const result = toolResultView(call);
        const last = index === calls.length - 1;
        return (
          <div
            key={call.id}
            className={`flex h-[30px] min-w-0 items-center gap-2 px-2.5 ${last ? "" : "border-b border-b-[#ffffff12]"}`}
          >
            <span className={`shrink-0 whitespace-nowrap ${MONO} text-[11px] leading-normal text-[#ecedee]`}>
              {call.name}
            </span>
            <span
              title={call.target}
              className={`min-w-0 flex-1 truncate ${MONO} text-[11px] leading-normal ${isMutationTool(call.name) ? "text-[#a7aab2]" : "text-[#8b8f98]"}`}
            >
              {call.target ?? ""}
            </span>
            <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1">
              {result.tone === "running" ? (
                <LuLoaderCircle aria-hidden className="size-3 shrink-0 animate-spin text-[#6ca6ff]" />
              ) : result.tone === "applied" ? (
                <LuCheck aria-hidden className="size-3 shrink-0 text-[#4cc38a]" />
              ) : result.tone === "error" ? (
                <LuX aria-hidden className="size-3 shrink-0 text-[#f2645a]" />
              ) : null}
              <span
                title={result.label}
                className={`min-w-0 truncate ${MONO} text-[11px] leading-normal ${
                  result.tone === "applied"
                    ? "text-[#4cc38a]"
                    : result.tone === "error"
                      ? "text-[#f2645a]"
                      : "text-[#8b8f98]"
                }`}
              >
                {result.label}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
