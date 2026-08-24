import type { ValidationFinding, ValidationResult } from "../config/validateCatalog.js";
import { effectiveSeverity } from "../config/validateCatalog.js";

export const VALIDATION_SCOPE_LINE =
  "Scope: pipeline and stage YAML only (task, checkout, providers not checked).";

export const VALIDATION_CHECKS = "pipeline and stage YAML only";

function effectiveSeverityRank(finding: ValidationFinding, strict: boolean): number {
  return effectiveSeverity(finding, strict) === "error" ? 0 : 1;
}

function orderedPaths(findings: ValidationFinding[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.path)) continue;
    seen.add(finding.path);
    paths.push(finding.path);
  }
  return paths;
}

function findingsForPath(
  findings: ValidationFinding[],
  filePath: string,
  strict: boolean,
): ValidationFinding[] {
  return findings
    .filter((finding) => finding.path === filePath)
    .sort((a, b) => {
      const sevCmp =
        effectiveSeverityRank(a, strict) - effectiveSeverityRank(b, strict);
      if (sevCmp !== 0) return sevCmp;
      return a.message.localeCompare(b.message);
    });
}

function formatSummary(result: ValidationResult): string {
  const { errors, warnings } = result.summary;
  if (result.ok) {
    if (result.findings.length === 0) {
      return "Validation passed.";
    }
    return `Validation passed: ${errors} error(s), ${warnings} warning(s).`;
  }
  return `Validation failed: ${errors} error(s), ${warnings} warning(s).`;
}

export function formatValidationHuman(
  result: ValidationResult,
  options: { strict?: boolean } = {},
): string {
  const strict = options.strict ?? false;
  const lines: string[] = [VALIDATION_SCOPE_LINE];

  if (result.findings.length > 0) {
    lines.push("");
    for (const filePath of orderedPaths(result.findings)) {
      lines.push(filePath);
      for (const finding of findingsForPath(result.findings, filePath, strict)) {
        const severity = effectiveSeverity(finding, strict);
        lines.push(`${severity}: ${finding.message}`);
      }
      lines.push("");
    }
    lines.pop();
  }

  lines.push("");
  lines.push(formatSummary(result));
  return lines.join("\n");
}

export function formatValidationJson(result: ValidationResult): string {
  const payload = {
    ok: result.ok,
    scope: result.scope,
    checks: VALIDATION_CHECKS,
    summary: result.summary,
    findings: result.findings.map((finding) => ({
      severity: finding.severity,
      category: finding.category,
      code: finding.code,
      file: finding.path,
      message: finding.message,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function exitCodeForValidation(result: ValidationResult): 0 | 1 {
  return result.ok ? 0 : 1;
}
