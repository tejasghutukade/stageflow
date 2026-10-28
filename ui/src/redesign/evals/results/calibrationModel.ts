import type { EvalCalibration, EvalCalibrationStats } from "../../../api/evalTypes";
import { formatCost } from "../format";

export const LOW_LABELS_HINT = "Label at least 20 results to get a reliable reading.";

function twoDecimals(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(2);
}

const WARNING_TEXT: Record<EvalCalibrationStats["warnings"][number], string> = {
  low_n: LOW_LABELS_HINT,
  imbalanced: "Your labels are mostly one verdict; label some of the other kind.",
  no_variance: "The judge and your labels each gave a single verdict, so kappa cannot be computed.",
};

export type CalibrationView = {
  headline: string;
  rows: Array<{ label: string; value: string }>;
  warnings: string[];
  disagreements: Array<{ key: string; caseId: string; repeatIndex: number; text: string; reason: string | null }>;
};

export function calibrationView(c: EvalCalibration): CalibrationView {
  const s = c.stats;
  return {
    headline: `${s.n} labels · agreement ${twoDecimals(s.agreement)} · kappa ${twoDecimals(s.cohen_kappa)}`,
    rows: [
      { label: "Judge passes when you pass", value: twoDecimals(s.tpr) },
      { label: "Judge fails when you fail", value: twoDecimals(s.tnr) },
      { label: "Judge", value: c.judge },
      { label: "Cost", value: formatCost(c.cost_usd) },
      ...(s.errored ? [{ label: "Judge errors (left out)", value: String(s.errored) }] : []),
      ...(s.stability && s.stability.n > 0
        ? [
            {
              label: `Judge changes its mind (${s.stability.k} calls each)`,
              value: `${twoDecimals(s.stability.flip_rate)} (${s.stability.unstable} of ${s.stability.n})`,
            },
          ]
        : []),
    ],
    warnings: s.warnings.map((w) => WARNING_TEXT[w]),
    disagreements: c.disagreements.map((d) => ({
      key: `${d.case_id}#${d.repeat_index}`,
      caseId: d.case_id,
      repeatIndex: d.repeat_index,
      text: `You ${d.label}, judge ${d.judge}`,
      reason: d.reason,
    })),
  };
}

/** True while a stored calibration still describes the grader as it is now. */
export function calibrationCurrent(c: EvalCalibration | null, graderHash: string | null, judge: string | null): boolean {
  if (c === null || c.candidate) return false;
  if (graderHash === null) return false;
  return c.grader_hash === graderHash && (judge === null || c.judge === judge);
}

export function calibrationBadge(c: EvalCalibration | null, current: boolean): string {
  if (c === null) return "Not calibrated";
  const kappa = c.stats.cohen_kappa;
  const text = `kappa ${twoDecimals(kappa)} on ${c.stats.n} labels`;
  return current ? `Calibrated: ${text}` : `Out of date: ${text}`;
}
