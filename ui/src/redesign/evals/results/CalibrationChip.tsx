import { useEffect, useState } from "react";
import { fetchEvalCalibrations } from "../../../api";
import type { EvalCalibration } from "../../../api/evalTypes";
import { calibrationBadge, calibrationCurrent } from "./calibrationModel";
import { Chip } from "./ResultsParts";

export function CalibrationChip({ evalId, graderId, graderHash }: { evalId: string; graderId: string; graderHash: string | null }) {
  const [latest, setLatest] = useState<EvalCalibration | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchEvalCalibrations(evalId, graderId).then(
      (page) => {
        if (!cancelled) setLatest(page.items[0] ?? null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [evalId, graderId]);
  const current = calibrationCurrent(latest, graderHash);
  return <Chip tone={latest && current ? "ok" : "muted"}>{calibrationBadge(latest, current)}</Chip>;
}
