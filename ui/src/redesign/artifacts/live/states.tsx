import type { ReactNode } from "react";
import { formatLiveRefreshed } from "../artifactDetailModel";

const NOT_ALLOWED = new Set([
  "artifact.binding_not_read_only",
  "artifact.binding_not_granted",
  "artifact.binding_unknown_function",
  "artifact.function_changed",
  "artifact.binding_args_invalid",
]);

export function liveErrorMessage(code: string | null | undefined): string {
  if (code === "artifact.resource_limit") return "The server is busy, will retry";
  if (code && NOT_ALLOWED.has(code)) return "This artifact's data source is no longer allowed";
  if (!code) return "The last refresh failed.";
  return "The data function failed";
}

export function LiveErrorBody({ code, fallback }: { code: string | null | undefined; fallback?: string }) {
  return (
    <>
      <p className="mt-1 text-[13px] text-[var(--sf-text-2)]">{code ? liveErrorMessage(code) : fallback ?? liveErrorMessage(null)}</p>
      {code ? <p className="sf-mono mt-1 text-[12px] text-[var(--sf-text-3)]">{code}</p> : null}
    </>
  );
}

export function LiveRefreshAge({ iso, nowMs = Date.now() }: { iso: string | null | undefined; nowMs?: number }) {
  if (!iso) return <span>unknown</span>;
  const formatted = formatLiveRefreshed(iso, nowMs);
  return <span title={formatted.title ?? undefined}>{formatted.label}</span>;
}

export function LiveStateCard({
  title,
  body,
  role = "status",
  children,
}: {
  title: string;
  body?: string;
  role?: "status" | "alert";
  children?: ReactNode;
}) {
  return (
    <div role={role} className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-4 py-3" data-sf-state={title}>
      <p className="text-[13px] font-medium text-[var(--sf-text-1)]">{title}</p>
      {body ? <p className="mt-1 text-[13px] text-[var(--sf-text-2)]">{body}</p> : null}
      {children}
    </div>
  );
}

export function LiveLoadingSkeleton() {
  return (
    <div role="status" data-sf-state="Loading" className="flex flex-col gap-2" aria-label="Loading">
      <div className="h-4 w-1/3 animate-pulse rounded bg-[var(--sf-raised)]" />
      <div className="h-24 animate-pulse rounded-lg bg-[var(--sf-raised)]" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--sf-raised)]" />
    </div>
  );
}

export function ProgramSource({ program }: { program: string }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">Program source</summary>
      <pre className="sf-mono mt-2 whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{program}</pre>
    </details>
  );
}
