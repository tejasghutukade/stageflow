import type { GraderConfig } from "./graderForms";
import { judgeCallsPerGrade, judgeSettingsOf, setJudgeSetting, TEMPERATURE_CHOICES, VOTE_CHOICES } from "./graderForms";
import { Field, SELECT } from "./parts";

export function JudgeSettingsFields({ grader, onChange }: { grader: GraderConfig; onChange: (next: GraderConfig) => void }) {
  const settings = judgeSettingsOf(grader);
  const calls = judgeCallsPerGrade(grader);
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="Judge temperature" hint="Lower is steadier. Default keeps the provider's setting.">
        <select
          className={SELECT}
          value={settings.temperature === undefined ? "" : String(settings.temperature)}
          onChange={(e) => onChange(setJudgeSetting(grader, "temperature", e.target.value === "" ? undefined : Number(e.target.value)))}
        >
          <option value="">Default</option>
          {TEMPERATURE_CHOICES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Judge votes" hint={calls > 1 ? `Majority of ${calls}. Costs ${calls}x judge calls.` : "One judge call per grade."}>
        <select
          className={SELECT}
          value={String(settings.votes ?? 1)}
          onChange={(e) => onChange(setJudgeSetting(grader, "votes", Number(e.target.value)))}
        >
          {VOTE_CHOICES.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </Field>
      <label className="flex items-start gap-2 pt-6 text-[13px] text-[var(--sf-text-2)]">
        <input
          type="checkbox"
          checked={settings.reasoning === true}
          onChange={(e) => onChange(setJudgeSetting(grader, "reasoning", e.target.checked))}
        />
        <span>Judge explains before it decides</span>
      </label>
    </div>
  );
}
