import { useEffect, useMemo, useRef, useState } from "react";
import { fetchRun, type RunDetail, type RunSummary } from "../../api";
import {
  mergeDurations,
  recentTerminalRuns,
  runP50Ms,
  stageDurationsFromDetail,
  summaryStageStats,
  type StageStats,
} from "./editorStageStats";

export function useEditorStageStats(runs: readonly RunSummary[]): {
  stageStats: Map<string, StageStats>;
  p50Ms: number | null;
} {
  const summaries = useMemo(() => summaryStageStats(runs), [runs]);
  const p50Ms = useMemo(() => runP50Ms(runs), [runs]);
  const detailKey = useMemo(
    () => recentTerminalRuns(runs).map((run) => run.run_id).join("\n"),
    [runs],
  );
  const cache = useRef(new Map<string, Promise<RunDetail | null>>());
  const [durations, setDurations] = useState<Map<string, number>[]>([]);

  useEffect(() => {
    let active = true;
    const ids = detailKey === "" ? [] : detailKey.split("\n");
    const pending = ids.map((id) => {
      const cached = cache.current.get(id);
      if (cached) return cached;
      const request = fetchRun(id).then(
        (detail) => detail,
        () => null,
      );
      cache.current.set(id, request);
      return request;
    });
    void Promise.all(pending).then((details) => {
      if (!active) return;
      const maps: Map<string, number>[] = [];
      for (const detail of details) {
        if (detail) maps.push(stageDurationsFromDetail(detail));
      }
      setDurations(maps);
    });
    return () => {
      active = false;
    };
  }, [detailKey]);

  const stageStats = useMemo(
    () => mergeDurations(summaries, durations),
    [summaries, durations],
  );

  return { stageStats, p50Ms };
}
