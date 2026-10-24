import { LuTriangleAlert } from "react-icons/lu";
import type { EvalAgentTool } from "../../../api/evalTypes";
import { ChipInput } from "./ChipInput";
import { CARD, Field, NumberField, SELECT, Section } from "./parts";
import {
  APPROVALS_NOTE,
  APPROVALS_OPTIONS,
  LIMITS_NOTE,
  MAX_TURNS_HELPER,
  MODE_HELPER,
  MODE_OPTIONS,
  READ_ONLY_TOOLS_HELPER,
  REAL_BLOCKED_NOTE,
  REAL_CHIP,
  REAL_CONSENT_LABEL,
  REAL_WARNING_BODY,
  REAL_WARNING_LEAD,
  TOOLS_OPTIONS,
  USER_MODEL_DEFAULT_LABEL,
  USER_MODEL_HELPER,
  conversationErrors,
  setTools,
  stubbedHint,
  type ConversationDraft,
} from "./conversationModel";

type Props = {
  value: ConversationDraft;
  onChange: (next: ConversationDraft) => void;
  agentTools: readonly EvalAgentTool[];
  judgeModels: readonly string[];
  /** Section number in the wizard; omitted on the edit page. */
  n?: number;
  /** `eval.simulator_*` findings for the user model, shown under the field. */
  userModelWarning?: string | null;
  userModelError?: string | null;
};

export function RealToolsPanel({
  checked,
  onChange,
  label = REAL_CONSENT_LABEL,
  blockedNote = REAL_BLOCKED_NOTE,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  blockedNote?: string;
}) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border-l-4 border-l-[var(--sf-needs)] bg-[var(--sf-needs-bg)] px-3.5 py-3">
      <p className="flex items-start gap-2 text-[13px] text-[var(--sf-text-1)]">
        <LuTriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--sf-needs)]" aria-hidden />
        <span>
          <strong>{REAL_WARNING_LEAD}</strong> {REAL_WARNING_BODY}
        </span>
      </p>
      <label className="flex items-center gap-2 pl-6 text-[13px] text-[var(--sf-text-1)]">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {!checked ? <p className="pl-6 text-xs text-[var(--sf-needs)]">{blockedNote}</p> : null}
    </div>
  );
}

export function ConversationCard({ value, onChange, agentTools, judgeModels, n, userModelWarning, userModelError }: Props) {
  const errors = conversationErrors(value);
  const patch = (next: Partial<ConversationDraft>) => onChange({ ...value, ...next });
  const hint = value.tools === "read_only" ? stubbedHint(agentTools, value.readOnlyTools) : null;
  const unknownMcp = agentTools.filter((t) => t.class === "mcp_unknown").map((t) => t.id);
  const real = value.tools === "real";

  const body = (
    <>
      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <div className="flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
          <span>Mode</span>
          <div className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5" role="radiogroup" aria-label="Mode">
            {MODE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={value.mode === o.value}
                onClick={() => patch({ mode: o.value })}
                className={`h-7 flex-1 rounded-md text-[13px] ${value.mode === o.value ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-[var(--sf-text-3)]">{MODE_HELPER}</span>
        </div>
        <Field label="Max turns" hint={MAX_TURNS_HELPER} error={errors.maxTurns}>
          <NumberField value={value.maxTurns} parse={(x) => (x.trim() === "" ? null : Number(x))} show={String} error={errors.maxTurns} onCommit={(n2) => patch({ maxTurns: n2 })} />
        </Field>
        <Field label="Turn timeout (seconds)" error={errors.turnTimeout}>
          <NumberField value={value.turnTimeoutSec} parse={(x) => (x.trim() === "" ? null : Number(x))} show={String} error={errors.turnTimeout} onCommit={(n2) => patch({ turnTimeoutSec: n2 })} />
        </Field>
      </div>

      {value.mode === "simulated" ? (
        <Field label="User model" hint={USER_MODEL_HELPER} {...(userModelError ? { error: userModelError } : {})} {...(userModelWarning ? { warn: userModelWarning } : {})}>
          <select className={SELECT} value={value.userModel ?? ""} onChange={(e) => patch({ userModel: e.target.value === "" ? null : e.target.value })}>
            <option value="">{USER_MODEL_DEFAULT_LABEL}</option>
            {judgeModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {value.userModel && !judgeModels.includes(value.userModel) ? <option value={value.userModel}>{value.userModel}</option> : null}
          </select>
        </Field>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-[var(--sf-text-2)]">Tools</span>
        <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Tools">
          {TOOLS_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={value.tools === o.value}
              onClick={() => onChange(setTools(value, o.value))}
              className={`${CARD} flex flex-col gap-1 p-3 text-left ${value.tools === o.value ? "border-[var(--sf-text-2)]" : ""}`}
            >
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{o.label}</span>
              <span className="text-xs text-[var(--sf-text-3)]">{o.body}</span>
            </button>
          ))}
        </div>
        {hint ? <p className="text-xs text-[var(--sf-text-3)]">{hint}</p> : null}
        {real ? <RealToolsPanel checked={value.allowReal} onChange={(v) => patch({ allowReal: v })} /> : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Approvals" hint={APPROVALS_NOTE[value.approvals]}>
          <select className={SELECT} value={value.approvals} onChange={(e) => patch({ approvals: e.target.value as ConversationDraft["approvals"] })}>
            {APPROVALS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
          <span>Read-only tools</span>
          <ChipInput values={value.readOnlyTools} onChange={(next) => patch({ readOnlyTools: next })} label="Read-only tool id" placeholder="server.tool or server.*" suggestions={unknownMcp} />
          {errors.readOnlyTools ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{errors.readOnlyTools}</span> : <span className="text-xs text-[var(--sf-text-3)]">{READ_ONLY_TOOLS_HELPER}</span>}
        </div>
      </div>
      <p className="border-t border-t-[var(--sf-hairline)] pt-3 text-xs text-[var(--sf-text-3)]">{LIMITS_NOTE}</p>
    </>
  );

  const chip = real ? (
    <span className="rounded border border-[var(--sf-needs)] bg-[var(--sf-needs-bg)] px-1.5 py-px text-[11px] font-medium tracking-wide text-[var(--sf-needs)]">{REAL_CHIP}</span>
  ) : null;

  if (n !== undefined) {
    return (
      <Section n={n} title="Conversation" hint="How the agent is exercised" right={chip}>
        {body}
      </Section>
    );
  }
  return (
    <section className={`${CARD} overflow-hidden`} aria-label="Conversation">
      <header className="flex items-center gap-2.5 border-b border-b-[var(--sf-hairline)] px-4 py-3">
        <h2 className="text-[14px] font-semibold text-[var(--sf-text-1)]">Conversation</h2>
        <span className="text-xs text-[var(--sf-text-3)]">How the agent is exercised</span>
        <span className="ml-auto">{chip}</span>
      </header>
      <div className="flex flex-col gap-3 p-4">{body}</div>
    </section>
  );
}
