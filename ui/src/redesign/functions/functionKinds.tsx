import type { ReactNode } from "react";
import { LuGitBranch, LuShieldCheck, LuWrench } from "react-icons/lu";
import type { FunctionKind } from "../../api/functions";
import { NOWRAP } from "../agents/agentsTokens";

export const FUNCTION_KINDS: FunctionKind[] = ["verification", "routing", "tool"];

type KindMeta = {
  label: string;
  icon: ReactNode;
  accent: string;
  summary: string;
  where: string;
  returns: string;
};

export const KIND_META: Record<FunctionKind, KindMeta> = {
  verification: {
    label: "Verification",
    icon: <LuShieldCheck aria-hidden />,
    accent: "text-[var(--sf-ok)]",
    summary: "Checks what a stage produced and says whether it passes.",
    where: "Attach as a check on a stage.",
    returns: "Return { passed, message }.",
  },
  routing: {
    label: "Routing",
    icon: <LuGitBranch aria-hidden />,
    accent: "text-[var(--sf-running)]",
    summary: "Picks which stages run next.",
    where: "Attach on the pipeline stage that owns the route.",
    returns: "Return { nextStageIds, reason }.",
  },
  tool: {
    label: "Tool",
    icon: <LuWrench aria-hidden />,
    accent: "text-[var(--sf-text-2)]",
    summary: "Gives a stage or an agent something it can call, with JSON in and JSON out.",
    where: "Attach on a stage or an agent.",
    returns: "Return any JSON value.",
  },
};

export function KindPill({ kind }: { kind: FunctionKind | null }) {
  if (!kind) {
    return <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Unknown</span>;
  }
  const meta = KIND_META[kind];
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-md bg-[var(--sf-raised)] px-2 text-xs leading-[1.33333] text-[var(--sf-text-1)] ${NOWRAP}`}
    >
      <span className={`flex shrink-0 [&>svg]:size-3 ${meta.accent}`}>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

export function slugId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
