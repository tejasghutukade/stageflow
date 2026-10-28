import type { ReactNode } from "react";
import {
  LuArrowUpRight,
  LuCheck,
  LuChevronRight,
  LuCircle,
  LuCircleCheck,
  LuCircleDot,
  LuCornerDownRight,
  LuHand,
  LuLoaderCircle,
  LuSend,
  LuShieldCheck,
  LuTriangleAlert,
} from "react-icons/lu";
import { evalPath } from "../../routes";
import { formatCost, formatPercent } from "../evals/format";
import { StatusPill } from "../StatusPill";
import type { GuideLink, GuideUi } from "./api";
import { orderStages, resourceSignal, toolActivityLabel } from "./guideUi";
import { guideLinkHref, guideLinkKindLabel, guideLinkLabel } from "./links";

type UiOf<C extends GuideUi["component"]> = Extract<GuideUi, { component: C }>;

const MAX_FAILURES = 5;
const MAX_DETAIL_CHARS = 4000;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Card({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section
      aria-label={label}
      className="flex w-full flex-col overflow-hidden rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] text-[13px] leading-snug text-[var(--sf-text-1)]"
    >
      {children}
    </section>
  );
}

function CardHeader({ eyebrow, title, meta, aside }: { eyebrow?: string; title: string; meta?: string; aside?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-[var(--sf-hairline)] px-3.5 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        {eyebrow ? <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--sf-text-3)]">{eyebrow}</span> : null}
        <h3 className="m-0 truncate text-[14px] font-semibold text-[var(--sf-text-1)]">{title}</h3>
        {meta ? <span className="truncate font-[family-name:var(--sf-font-mono)] text-[11.5px] text-[var(--sf-text-3)]">{meta}</span> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}

function CardBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 px-3.5 py-3">{children}</div>;
}

function OpenLink({ href, label = "Open in console" }: { href: string | null; label?: string }) {
  if (!href) return null;
  return (
    <footer className="flex items-center justify-end border-t border-[var(--sf-hairline)] px-3.5 py-2">
      <a href={href} className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--sf-running)] no-underline hover:underline">
        {label}
        <LuArrowUpRight aria-hidden className="size-3.5" />
      </a>
    </footer>
  );
}

function Chip({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone: "needs" | "ok" | "running" }) {
  const color = tone === "needs" ? "text-[var(--sf-needs)]" : tone === "ok" ? "text-[var(--sf-ok)]" : "text-[var(--sf-running)]";
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--sf-raised)] px-1.5 py-0.5 text-[11px] text-[var(--sf-text-2)]">
      <span className={`inline-flex ${color}`}>{icon}</span>
      {children}
    </span>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--sf-text-3)]">{children}</span>;
}

export function PipelineCard({ ui }: { ui: UiOf<"pipeline"> }) {
  const { pipeline, validation } = ui;
  const stages = orderStages(pipeline.stages);
  const status = validation.ok ? (
    <StatusPill signal="ok" label={validation.warnings > 0 ? `Valid · ${plural(validation.warnings, "warning")}` : "Valid"} />
  ) : (
    <StatusPill signal="fail" label={plural(validation.errors, "error")} />
  );
  const meta = [pipeline.path || pipeline.id, pipeline.model].filter(Boolean).join(" · ");
  return (
    <Card label={`Pipeline ${ui.title}`}>
      <CardHeader eyebrow="Pipeline" title={ui.title} meta={meta} aside={status} />
      <CardBody>
        {stages.length > 0 ? (
          <ol aria-label="Stages" className="m-0 flex list-none flex-col p-0">
            {stages.map((stage, index) => (
              <li key={stage.id} className="flex gap-2.5">
                <div className="flex flex-col items-center">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] font-[family-name:var(--sf-font-mono)] text-[10.5px] text-[var(--sf-text-2)]">
                    {index + 1}
                  </span>
                  {index < stages.length - 1 ? <span aria-hidden className="w-px flex-1 bg-[var(--sf-hairline-strong)]" /> : null}
                </div>
                <div className={`flex min-w-0 flex-1 flex-col gap-1 ${index < stages.length - 1 ? "pb-3" : ""}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-[family-name:var(--sf-font-mono)] text-[12.5px] font-medium text-[var(--sf-text-1)]">{stage.id}</span>
                    {(stage.gates ?? []).map((gate) => (
                      <Chip key={`gate-${gate}`} tone="needs" icon={<LuHand aria-hidden className="size-3" />}>
                        {gate} gate
                      </Chip>
                    ))}
                    {stage.hasVerify ? (
                      <Chip tone="ok" icon={<LuShieldCheck aria-hidden className="size-3" />}>
                        verify
                      </Chip>
                    ) : null}
                    {(stage.channels ?? []).map((channel) => (
                      <Chip key={`channel-${channel}`} tone="running" icon={<LuSend aria-hidden className="size-3" />}>
                        {channel}
                      </Chip>
                    ))}
                    {stage.model ? <span className="text-[11px] text-[var(--sf-text-3)]">{stage.model}</span> : null}
                  </div>
                  {(stage.needs ?? []).length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--sf-text-3)]">
                      <LuCornerDownRight aria-hidden className="size-3" />
                      after {stage.needs.join(", ")}
                    </span>
                  ) : null}
                  {stage.summary ? <p className="m-0 line-clamp-2 text-[12px] text-[var(--sf-text-2)]">{stage.summary}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-[12px] text-[var(--sf-text-3)]">No stages yet.</p>
        )}
        {validation.messages.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {validation.messages.slice(0, 3).map((message, index) => (
              <li key={index} className="flex items-start gap-1.5 text-[12px] text-[var(--sf-text-2)]">
                <LuTriangleAlert aria-hidden className={`mt-0.5 size-3 shrink-0 ${validation.ok ? "text-[var(--sf-needs)]" : "text-[var(--sf-fail)]"}`} />
                <span className="min-w-0 break-words">{message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {pipeline.task ? (
          <div className="flex flex-col gap-0.5 rounded-lg bg-[var(--sf-raised)] px-2.5 py-2">
            <Label>Task · {pipeline.task.id}</Label>
            <p className="m-0 text-[12.5px] text-[var(--sf-text-1)]">{pipeline.task.goal}</p>
          </div>
        ) : null}
        {pipeline.memories.length > 0 ? (
          <p className="m-0 text-[12px] text-[var(--sf-text-2)]">
            <span className="text-[var(--sf-text-3)]">Memory </span>
            {pipeline.memories.join(", ")}
          </p>
        ) : null}
      </CardBody>
      <OpenLink href={guideLinkHref(ui.link)} />
    </Card>
  );
}

export function ResourceCard({ ui }: { ui: UiOf<"resource"> }) {
  return (
    <Card label={`${guideLinkKindLabel(ui.kind)} ${ui.title}`}>
      <CardHeader
        eyebrow={guideLinkKindLabel(ui.kind)}
        title={ui.title}
        aside={ui.status ? <StatusPill signal={resourceSignal(ui.status)} label={ui.status} /> : null}
      />
      {ui.fields.length > 0 ? (
        <CardBody>
          <dl className="m-0 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {ui.fields.map((field, index) => (
              <div key={`${field.label}-${index}`} className="contents">
                <dt className="text-[12px] text-[var(--sf-text-3)]">{field.label}</dt>
                <dd className="m-0 break-words text-[12.5px] text-[var(--sf-text-1)]">{field.value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      ) : null}
      <OpenLink href={guideLinkHref(ui.link)} />
    </Card>
  );
}

const STEP_ICON = {
  done: <LuCircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sf-ok)]" />,
  current: <LuCircleDot aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sf-running)]" />,
  todo: <LuCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sf-text-3)]" />,
};

const STEP_LABEL = { done: "Done", current: "In progress", todo: "To do" };

export function PlanCard({ ui }: { ui: UiOf<"plan"> }) {
  const done = ui.steps.filter((step) => step.status === "done").length;
  return (
    <Card label={`Plan ${ui.title}`}>
      <CardHeader eyebrow="Plan" title={ui.title} aside={<span className="text-[12px] text-[var(--sf-text-3)]">{`${done} of ${ui.steps.length} done`}</span>} />
      <CardBody>
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {ui.steps.map((step, index) => (
            <li key={index} className="flex items-start gap-2" data-status={step.status}>
              {STEP_ICON[step.status] ?? STEP_ICON.todo}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={`text-[13px] ${
                    step.status === "done"
                      ? "text-[var(--sf-text-2)] line-through decoration-[var(--sf-text-3)]"
                      : step.status === "current"
                        ? "font-medium text-[var(--sf-text-1)]"
                        : "text-[var(--sf-text-1)]"
                  }`}
                >
                  <span className="sr-only">{STEP_LABEL[step.status] ?? STEP_LABEL.todo}: </span>
                  {step.title}
                </span>
                {step.detail ? <span className="text-[12px] text-[var(--sf-text-2)]">{step.detail}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

export type ChoicesCardProps = {
  ui: UiOf<"choices">;
  confirm?: boolean;
  disabled: boolean;
  onPick: (label: string) => void;
  onOther: () => void;
};

const CONFIRM_YES = "yes";

function ConfirmButtons({ ui, disabled, onPick }: Pick<ChoicesCardProps, "ui" | "disabled" | "onPick">) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ui.options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={disabled}
          data-primary={option.id === CONFIRM_YES ? "" : undefined}
          title={option.description}
          onClick={() => onPick(option.label)}
          className={
            option.id === CONFIRM_YES
              ? "rounded-lg bg-[var(--sf-text-1)] px-3 py-1.5 text-[13px] font-medium text-[var(--sf-ground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              : "rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-ground)] px-3 py-1.5 text-[13px] font-medium text-[var(--sf-text-1)] hover:bg-[var(--sf-active)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--sf-ground)]"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ChoicesCard({ ui, confirm = false, disabled, onPick, onOther }: ChoicesCardProps) {
  return (
    <Card label={confirm ? "Confirm action" : "Choices"}>
      <CardBody>
        {confirm ? (
          <div className="flex items-start gap-2">
            <LuHand aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sf-needs)]" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label>Confirm</Label>
              <p className="m-0 text-[14px] font-semibold text-[var(--sf-text-1)]">{ui.question}</p>
            </div>
          </div>
        ) : (
          <p className="m-0 text-[13.5px] font-medium text-[var(--sf-text-1)]">{ui.question}</p>
        )}
        <div className="flex flex-col gap-1.5">
          {confirm ? (
            <ConfirmButtons ui={ui} disabled={disabled} onPick={onPick} />
          ) : (
            ui.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => onPick(option.label)}
                className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-ground)] px-3 py-2 text-left hover:bg-[var(--sf-active)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--sf-ground)]"
              >
                <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{option.label}</span>
                {option.description ? <span className="text-[12px] text-[var(--sf-text-2)]">{option.description}</span> : null}
              </button>
            ))
          )}
          {ui.allowOther ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onOther}
              className="self-start rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--sf-text-2)] hover:bg-[var(--sf-active)] hover:text-[var(--sf-text-1)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Something else…
            </button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label>{label}</Label>
      <span className="font-[family-name:var(--sf-font-mono)] text-[15px] text-[var(--sf-text-1)]">{value}</span>
    </div>
  );
}

export function EvalReportCard({ ui }: { ui: UiOf<"eval_report"> }) {
  const pill =
    ui.passed === true ? (
      <StatusPill signal="ok" label="Passed" />
    ) : ui.passed === false ? (
      <StatusPill signal="fail" label="Failed" />
    ) : (
      <StatusPill signal={resourceSignal(ui.status)} label={ui.status} />
    );
  const shown = ui.failures.slice(0, MAX_FAILURES);
  const hidden = ui.failures.length - shown.length;
  return (
    <Card label={`Eval report ${ui.title}`}>
      <CardHeader eyebrow="Eval run" title={ui.title} meta={ui.evalId} aside={pill} />
      <CardBody>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Pass rate" value={formatPercent(ui.passRate)} />
          <Stat label="Cases" value={String(ui.cases)} />
          <Stat label="Cost" value={formatCost(ui.costUsd)} />
        </div>
        {shown.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label>Failures</Label>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {shown.map((failure) => (
                <li key={failure.caseId} className="flex flex-col gap-0.5 rounded-lg bg-[var(--sf-raised)] px-2.5 py-1.5">
                  <span className="font-[family-name:var(--sf-font-mono)] text-[12px] text-[var(--sf-text-1)]">{failure.caseId}</span>
                  <span className="line-clamp-2 text-[12px] text-[var(--sf-text-2)]">{failure.reason}</span>
                </li>
              ))}
            </ul>
            {hidden > 0 ? <span className="text-[12px] text-[var(--sf-text-3)]">{`${hidden} more in the console`}</span> : null}
          </div>
        ) : null}
      </CardBody>
      <OpenLink href={guideLinkHref(ui.link) ?? (ui.evalId ? `#${evalPath(ui.evalId)}` : null)} />
    </Card>
  );
}

function LinkRow({ link }: { link: GuideLink }) {
  const href = guideLinkHref(link);
  const label = guideLinkLabel(link);
  return (
    <li className="flex items-center justify-between gap-3 px-3.5 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--sf-text-3)]">{guideLinkKindLabel(link.kind)}</span>
        {href ? (
          <a href={href} className="truncate text-[13px] text-[var(--sf-running)] no-underline hover:underline">
            {label}
          </a>
        ) : (
          <span className="truncate text-[13px] text-[var(--sf-text-1)]">{label}</span>
        )}
      </div>
      {href ? <LuArrowUpRight aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" /> : null}
    </li>
  );
}

export function LinksCard({ ui }: { ui: UiOf<"links"> }) {
  return (
    <Card label={ui.title ?? "Links"}>
      {ui.title ? <CardHeader title={ui.title} /> : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-[var(--sf-hairline)] p-0">
        {ui.links.map((link, index) => (
          <LinkRow key={`${link.kind}-${link.id}-${index}`} link={link} />
        ))}
      </ul>
    </Card>
  );
}

/** Every `show_ui` card except choices, which needs the thread to send a reply. */
export function GuideUiCard({ ui }: { ui: Exclude<GuideUi, { component: "choices" }> }) {
  switch (ui.component) {
    case "pipeline":
      return <PipelineCard ui={ui} />;
    case "resource":
      return <ResourceCard ui={ui} />;
    case "plan":
      return <PlanCard ui={ui} />;
    case "eval_report":
      return <EvalReportCard ui={ui} />;
    case "links":
      return <LinksCard ui={ui} />;
  }
}

export type ToolActivityState = "running" | "complete" | "error" | "stopped";

function detailText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n…` : text;
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <pre className="m-0 max-h-60 overflow-auto rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-2.5 py-2 font-[family-name:var(--sf-font-mono)] text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-[var(--sf-text-2)]">
        {detailText(value)}
      </pre>
    </div>
  );
}

export type ToolActivityProps = {
  name: string;
  state: ToolActivityState;
  args?: Record<string, unknown> | undefined;
  result?: unknown;
  error?: string | undefined;
};

/** One compact, collapsible row for a tool call the agent made. */
export function ToolActivity({ name, state, args, result, error }: ToolActivityProps) {
  const label = toolActivityLabel(name, state === "running" || state === "stopped");
  const hasArgs = args !== undefined && Object.keys(args).length > 0;
  const hasResult = state === "complete" && result !== undefined && result !== null;
  const expandable = hasArgs || hasResult || state === "error";
  const icon =
    state === "running" ? (
      <LuLoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-[var(--sf-running)] motion-reduce:animate-none" />
    ) : state === "error" ? (
      <LuTriangleAlert aria-hidden className="size-3.5 shrink-0 text-[var(--sf-fail)]" />
    ) : state === "stopped" ? (
      <LuCircle aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
    ) : (
      <LuCheck aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
    );
  const suffix = state === "error" ? "failed" : state === "stopped" ? "stopped" : null;
  const summary = (
    <>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {suffix ? <span className="shrink-0 text-[var(--sf-text-3)]">· {suffix}</span> : null}
    </>
  );
  if (!expandable) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-[13px] text-[var(--sf-text-2)]" data-tool={name} data-state={state} role={state === "running" ? "status" : undefined}>
        {summary}
      </div>
    );
  }
  return (
    <details
      className="group rounded-lg border border-transparent text-[13px] open:border-[var(--sf-hairline)] open:bg-[var(--sf-panel)]"
      data-tool={name}
      data-state={state}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1 text-[var(--sf-text-2)] hover:bg-[var(--sf-active)] hover:text-[var(--sf-text-1)] [&::-webkit-details-marker]:hidden"
        role={state === "running" ? "status" : undefined}
      >
        {summary}
        <LuChevronRight aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)] transition-transform group-open:rotate-90" />
      </summary>
      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
        {state === "error" ? (
          <p className="m-0 rounded-md bg-[var(--sf-fail-bg)] px-2.5 py-1.5 text-[12px] text-[var(--sf-text-2)]">{error || "The tool call failed."}</p>
        ) : null}
        {hasArgs ? <Detail label="Input" value={args} /> : null}
        {hasResult ? <Detail label="Result" value={result} /> : null}
      </div>
    </details>
  );
}
