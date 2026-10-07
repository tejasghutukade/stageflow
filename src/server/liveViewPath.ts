export type LiveViewRouteKind = "ticket" | "events" | "input" | "dialog";

export type LiveViewRouteMatch = {
  kind: LiveViewRouteKind;
  /** Raw (still percent-encoded) path segments. */
  rawRunId: string;
  rawStageId: string;
};

const LIVE_VIEW_ROUTE = /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/live-view\/(ticket|events|input|dialog)$/;

/** Sole definition of the live-view path shape; path-only, method is checked by each consumer. */
export function matchLiveViewRoute(pathname: string): LiveViewRouteMatch | null {
  const m = LIVE_VIEW_ROUTE.exec(pathname);
  if (m === null) return null;
  return { rawRunId: m[1]!, rawStageId: m[2]!, kind: m[3] as LiveViewRouteKind };
}
