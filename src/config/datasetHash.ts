import { canonicalJson, sha256Hex } from "../evals/canonical.js";

export function datasetContentHash(cases: readonly unknown[]): string {
  return sha256Hex(cases.map((c) => canonicalJson(c)).join("\n"));
}
