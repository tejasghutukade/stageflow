import { createTheme, defaultDarkTheme } from "@openuidev/react-ui/ThemeProvider";

const fontUi = "var(--sf-font-ui)";
const fontMono = "var(--sf-font-mono)";

/** OpenUI theme keys that follow a console token. Chart colors are separate. */
export const SF_OPENUI_TOKEN_MAP = {
  background: "var(--sf-ground)",
  foreground: "var(--sf-text-1)",
  popoverBackground: "var(--sf-panel)",
  sunk: "var(--sf-ground)",
  sunkDeep: "var(--sf-rail)",
  elevatedLight: "var(--sf-active)",
  elevated: "var(--sf-panel)",
  elevatedStrong: "var(--sf-raised)",
  elevatedIntense: "var(--sf-raised)",
  textNeutralPrimary: "var(--sf-text-1)",
  textNeutralSecondary: "var(--sf-text-2)",
  textNeutralTertiary: "var(--sf-text-3)",
  textNeutralLink: "var(--sf-running)",
  textBrand: "var(--sf-text-1)",
  textAccentPrimary: "var(--sf-ground)",
  textAccentSecondary: "var(--sf-text-1)",
  textSuccessPrimary: "var(--sf-ok)",
  textSuccessInverted: "var(--sf-ok)",
  textAlertPrimary: "var(--sf-needs)",
  textAlertInverted: "var(--sf-needs)",
  textDangerPrimary: "var(--sf-fail)",
  textDangerSecondary: "var(--sf-fail)",
  textDangerInvertedPrimary: "var(--sf-fail)",
  textInfoPrimary: "var(--sf-running)",
  textInfoInverted: "var(--sf-running)",
  successBackground: "var(--sf-ok-bg)",
  alertBackground: "var(--sf-needs-bg)",
  dangerBackground: "var(--sf-fail-bg)",
  infoBackground: "var(--sf-running-bg)",
  interactiveAccentDefault: "var(--sf-running)",
  interactiveDestructiveDefault: "var(--sf-fail)",
  borderDefault: "var(--sf-hairline)",
  borderInteractive: "var(--sf-hairline-strong)",
  fontBody: fontUi,
  fontHeading: fontUi,
  fontLabel: fontUi,
  fontNumbers: fontUi,
  fontCode: fontMono,
} as const;

/** Categorical order: running, ok, needs, fail, queued. One series uses the first entry. */
export const CHART_COLORS = [
  "var(--sf-running)",
  "var(--sf-ok)",
  "var(--sf-needs)",
  "var(--sf-fail)",
  "var(--sf-queued)",
] as const;

/**
 * OpenUI picks series colors from the middle of the ramp (`getDistributedColors`),
 * so a 5-color palette paints the first series with the third entry (amber in the spike).
 * This builds a ramp that the same function maps back to `CHART_COLORS` order.
 */
export function chartPaletteForSeries(count: number): string[] {
  const n = Math.max(count, 1);
  const desired = Array.from({ length: n }, (_, index) => CHART_COLORS[index % CHART_COLORS.length]!);
  const slot = new Array<string>(n).fill(desired[0]!);
  const mid = Math.floor(n / 2);
  const wrap = (index: number) => (index % n + n) % n;
  if (n === 1) {
    slot[mid] = desired[0]!;
    return slot;
  }
  if (n === 2) {
    slot[Math.max(mid - 1, 0)] = desired[0]!;
    slot[Math.min(mid + 1, n - 1)] = desired[1]!;
    return slot;
  }
  const offset = Math.floor((n - 1) / 2);
  for (let index = 0; index < n; index += 1) slot[wrap(mid + (index - offset))] = desired[index]!;
  return slot;
}

function replaceFonts(value: string): string {
  return value
    .replaceAll('"Inter", sans-serif', fontUi)
    .replaceAll('"SFMono-Regular", Menlo, monospace', fontMono);
}

export function stageflowOpenUiTheme(): ReturnType<typeof createTheme> {
  const base = { ...defaultDarkTheme } as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") base[key] = replaceFonts(value);
  }
  return createTheme({
    ...base,
    ...SF_OPENUI_TOKEN_MAP,
    radiusS: "6px",
    radiusM: "8px",
    radiusL: "8px",
    radiusXl: "12px",
    radius2xl: "12px",
    defaultChartPalette: [...CHART_COLORS],
    barChartPalette: [...CHART_COLORS],
    lineChartPalette: [...CHART_COLORS],
    areaChartPalette: [...CHART_COLORS],
  });
}
