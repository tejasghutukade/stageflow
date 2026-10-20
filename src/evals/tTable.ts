const T_95_TWO_SIDED = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
] as const;

export const T_TABLE_MAX_DF = T_95_TWO_SIDED.length;
export const T_LARGE_DF_QUANTILE = 1.96;

export function tQuantile(df: number): number {
  if (!Number.isInteger(df) || df < 1) {
    throw new RangeError(`degrees of freedom must be an integer >= 1, got ${df}`);
  }
  if (df > T_TABLE_MAX_DF) return T_LARGE_DF_QUANTILE;
  return T_95_TWO_SIDED[df - 1];
}
