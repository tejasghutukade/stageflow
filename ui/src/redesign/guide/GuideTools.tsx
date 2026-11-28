import { useAui, useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { lazy, Suspense } from "react";
import type { GuideUi } from "./api";
import { ChoicesCard, GuideUiCard, ToolActivity, type ToolActivityState } from "./GuideCards";
import { readGuideUi, readPresentUiCard, readSavedCard } from "./guideUi";

const GuidePresentCard = lazy(() =>
  import("./GuidePresentCard").then((mod) => ({ default: mod.GuidePresentCard })),
);
const GuideSavedCard = lazy(() =>
  import("./GuideSavedCard").then((mod) => ({ default: mod.GuideSavedCard })),
);

const CONFIRM_TOOL = "confirm_action";

export function toolActivityState(part: Pick<ToolCallMessagePartProps, "result" | "isError" | "status">): ToolActivityState {
  if (part.isError) return "error";
  if (part.result !== undefined) return "complete";
  return part.status.type === "running" ? "running" : "stopped";
}

function withoutConfirmationId(result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result) || !("confirmation_id" in result)) return result;
  const { confirmation_id: _, ...rest } = result as Record<string, unknown>;
  return rest;
}

export function GuideToolActivity(props: Pick<ToolCallMessagePartProps, "toolName" | "args" | "result" | "isError" | "status">) {
  const state = toolActivityState(props);
  return (
    <ToolActivity
      name={props.toolName}
      state={state}
      args={props.args as Record<string, unknown>}
      result={withoutConfirmationId(props.result)}
      error={state === "error" && typeof props.result === "string" ? props.result : undefined}
    />
  );
}

function GuideChoices({ ui, confirm }: { ui: Extract<GuideUi, { component: "choices" }>; confirm: boolean }) {
  const aui = useAui();
  const disabled = useAuiState((state) => !state.message.isLast || state.thread.isRunning);
  return (
    <ChoicesCard
      ui={ui}
      confirm={confirm}
      disabled={disabled}
      onPick={(label) => {
        aui.thread().append({ role: "user", content: [{ type: "text", text: label }] });
      }}
      onOther={() => {
        document.querySelector<HTMLTextAreaElement>('.sf-guide textarea[aria-label="Message"]')?.focus();
      }}
    />
  );
}

export type GuideToolView =
  | { kind: "activity" }
  | { kind: "choices"; ui: Extract<GuideUi, { component: "choices" }>; confirm: boolean }
  | { kind: "card"; ui: Exclude<GuideUi, { component: "choices" }> }
  | { kind: "present"; part: import("../../../../src/artifacts/uiPartCard.ts").UiPartCard }
  | { kind: "artifact"; part: import("../../../../src/artifacts/uiPartArtifactRef.ts").UiPartArtifactRef };

/** Any tool whose result carries a drawable `ui` shows that card; every other call is an activity row. */
export function guideToolView(part: Pick<ToolCallMessagePartProps, "toolName" | "result" | "isError" | "status">): GuideToolView {
  if (part.toolName === "present_ui" && toolActivityState(part) === "complete") {
    const card = readPresentUiCard(part.result);
    if (card) return { kind: "present", part: card };
  }
  if (part.toolName === "save_card" && toolActivityState(part) === "complete") {
    const saved = readSavedCard(part.result);
    if (saved) return { kind: "artifact", part: saved };
  }
  const ui = toolActivityState(part) === "complete" ? readGuideUi(part.result) : null;
  if (!ui) return { kind: "activity" };
  if (ui.component === "choices") return { kind: "choices", ui, confirm: part.toolName === CONFIRM_TOOL };
  return { kind: "card", ui };
}

function GuideToolPart(props: ToolCallMessagePartProps) {
  const view = guideToolView(props);
  if (view.kind === "choices") return <GuideChoices ui={view.ui} confirm={view.confirm} />;
  if (view.kind === "card") return <GuideUiCard ui={view.ui} />;
  if (view.kind === "present") {
    return (
      <Suspense fallback={<p className="m-0 text-[13px] text-[var(--sf-text-3)]">Loading card…</p>}>
        <GuidePresentCard part={view.part} />
      </Suspense>
    );
  }
  if (view.kind === "artifact") {
    return (
      <Suspense fallback={<p className="m-0 text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p>}>
        <GuideSavedCard part={view.part} />
      </Suspense>
    );
  }
  return <GuideToolActivity {...props} />;
}

export const GUIDE_TOOLS = {
  Fallback: GuideToolPart,
};
