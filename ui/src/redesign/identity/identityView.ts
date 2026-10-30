import type { IdentityAssignment, IdentityConnection, IdentityScope } from "../../api/identity";

export const PREVIEW_COPY = "Preview does not activate this assignment.";
export const FAILED_TEST_COPY = "A failed test does not replace the active connection.";
export const JWKS_WRITE_ONLY_COPY = "The public key set is write-only. It is not shown after you register.";
export const SECRET_WRITE_ONLY_COPY = "The client secret is sent only when you register or rotate. It is not shown again.";

export const IDENTITY_SCOPES: readonly IdentityScope[] = ["own", "assigned", "selected", "workspace"];

export function oidcActivateReady(recordedTest: boolean): boolean {
  return recordedTest;
}

export function matchingAssignment(
  assignments: readonly IdentityAssignment[],
  connectionId: string,
  subject: string,
): IdentityAssignment | undefined {
  const id = connectionId.trim();
  const person = subject.trim();
  if (!id || !person) return undefined;
  return assignments.find((row) => row.connectionId === id && row.subject === person);
}

export function splitResourceList(value: string): string[] {
  return value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
}

export function previewWord(outcome: "allow" | "deny"): "Allow" | "Deny" {
  return outcome === "allow" ? "Allow" : "Deny";
}

export function identityConnectionLines(connection: IdentityConnection): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [
    { label: "Kind", value: connection.kind },
    { label: "Status", value: connection.status },
    { label: "Active", value: connection.active ? "Active" : "Inactive" },
    { label: "Issuer", value: connection.issuer },
    { label: "Callback", value: connection.callbackPath },
  ];
  if (connection.issuerChecks.length > 0) {
    lines.push({ label: "Issuer checks", value: connection.issuerChecks.join("\n") });
  }
  lines.push({ label: "Upstream revocation", value: connection.upstreamRevocation });
  if (connection.upstreamRevocation === "local_only") {
    lines.push({ label: "Upstream note", value: connection.upstreamNote });
  }
  return lines;
}
