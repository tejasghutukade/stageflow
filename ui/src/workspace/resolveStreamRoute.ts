import type { RunDetail } from "../api";
import type { DetailView } from "../routes";
import { stageIdKnown } from "./resolveRunWorkspace";

export type StreamRouteCommand =
  | { action: "none" }
  | { action: "openStream"; stageId?: string };

export type StreamRouteInput = {
  view: DetailView;
  streamViewStageId: string | undefined;
  run: RunDetail | null;
  plannedStageIds: string[];
  selectedStageId: string | null;
  syncStreamRoute: boolean;
  userPickedStageId: string | null;
  dismissedWaitKey: string | null;
};

export function resolveStreamRoute(input: StreamRouteInput): StreamRouteCommand {
  if (input.syncStreamRoute) {
    return { action: "openStream", stageId: input.selectedStageId ?? undefined };
  }

  if (input.view.kind !== "stream" || !input.run) {
    return { action: "none" };
  }

  if (
    input.streamViewStageId &&
    !stageIdKnown(input.run, input.streamViewStageId, input.plannedStageIds)
  ) {
    return { action: "openStream" };
  }

  if (input.userPickedStageId || input.dismissedWaitKey) {
    return { action: "none" };
  }

  if (!input.selectedStageId || input.streamViewStageId === input.selectedStageId) {
    return { action: "none" };
  }

  return { action: "openStream", stageId: input.selectedStageId };
}
