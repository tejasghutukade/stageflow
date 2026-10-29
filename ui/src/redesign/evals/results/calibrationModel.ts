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
export function calibrationCurrent(c: EvalCalibration | null, graderHash: string | null): boolean {
  if (c === null || c.candidate) return false;
  if (graderHash === null) return false;
  return c.grader_hash === graderHash;
}

export function calibrationBadge(c: EvalCalibration | null, current: boolean): string {
  if (c === null) return "Not calibrated";
  const kappa = c.stats.cohen_kappa;
  const text = `kappa ${twoDecimals(kappa)} on ${c.stats.n} labels`;
  return current ? `Calibrated: ${text}` : `Out of date: ${text}`;
}

export type Reliability = {
  tone: "ok" | "needs" | "fail" | "muted";
  /** A plain-words verdict for the first line. */
  title: string;
  /** What that means in counts, e.g. "Matches your label on 24 of 28". */
  detail: string;
  /** Which way the judge is wrong, or null when it never is. */
  mistakes: string | null;
};

/** The numbers in words: the kappa bands are the usual reading (0.6 and up is decent), the counts come from the API. */
export function reliabilityView(c: EvalCalibration): Reliability {
  const { cohen_kappa: kappa, n, confusion } = c.stats;
  const matches = confusion.tp + confusion.tn;
  const detail = n === 0 ? "No labels were checked." : `Matches your label on ${matches} of ${n}.`;
  const parts = [
    confusion.fp > 0 ? `too lenient on ${confusion.fp} (passes what you failed)` : null,
    confusion.fn > 0 ? `too strict on ${confusion.fn} (fails what you passed)` : null,
  ].filter((part): part is string => part !== null);
  const mistakes = parts.length === 0 ? null : `${parts.join(", ")}.`.replace(/^./, (ch) => ch.toUpperCase());
  if (kappa === null || !Number.isFinite(kappa)) {
    return { tone: "muted", title: "Not enough to tell yet", detail, mistakes };
  }
  if (kappa >= 0.6) return { tone: "ok", title: "Mostly agrees with you", detail, mistakes };
  if (kappa >= 0.4) return { tone: "needs", title: "Agrees only partly", detail, mistakes };
  return { tone: "fail", title: "Often disagrees with you", detail, mistakes };
}
