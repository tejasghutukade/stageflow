import { useMemo, useState } from "react";
import { LuSend } from "react-icons/lu";
import { parseUiPartForm, UI_PART_KIND_FORM, coerceFormValues, fillFormTemplate, formUiEventKey, validateFormValues } from "../../../../src/artifacts/uiPartForm.ts";
import { lookupUiPart, registerUiPart, type UiPartRendererProps } from "./registry";
import { postChatAction } from "./chatActions";

function FormPart({ part, context }: UiPartRendererProps) {
  const parsed = parseUiPartForm(part);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const form = parsed.ok ? parsed.part : null;
  const interactive = Boolean(context.chat) && !submitted;

  const fieldDefaults = useMemo(() => {
    if (!form) return {};
    const defaults: Record<string, unknown> = {};
    for (const field of form.fields) {
      if (field.type === "boolean") defaults[field.id] = false;
    }
    return defaults;
  }, [form]);

  if (!form) return lookupUiPart("")({ part, context });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !context.chat || busy) return;
    const merged = { ...fieldDefaults, ...values };
    const nextIssues = validateFormValues(form, merged);
    if (nextIssues.length > 0) {
      setIssues(Object.fromEntries(nextIssues.map((issue) => [issue.field, issue.message])));
      return;
    }
    setIssues({});
    const coerced = coerceFormValues(form, merged);
    let text: string;
    try {
      text = fillFormTemplate(form.submit.template, coerced);
    } catch {
      setIssues({ form: "The form could not be submitted" });
      return;
    }
    setBusy(true);
    try {
      await postChatAction(context.chat!, {
        key: formUiEventKey(form.id),
        kind: "message",
        action: "submit",
        args: { text },
      });
      setSubmitted(true);
    } catch {
      setIssues({ form: "Could not send your answers" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4"
    >
      <div>
        <p className="m-0 text-[13px] font-medium text-[var(--sf-text-1)]">{form.title}</p>
        {form.description ? <p className="mt-1 mb-0 text-[12px] leading-normal text-[var(--sf-text-2)]">{form.description}</p> : null}
      </div>
      {form.fields.map((field) => {
        const issue = issues[field.id];
        return (
          <label key={field.id} className="flex flex-col gap-1 text-[13px] text-[var(--sf-text-1)]">
            <span>
              {field.label}
              {field.required !== false ? <span className="text-[var(--sf-fail)]"> *</span> : null}
            </span>
            {field.type === "string" ? (
              field.multiline ? (
                <textarea
                  rows={3}
                  disabled={!interactive || busy}
                  value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  className="resize-y rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-2 py-1.5 text-[13px] text-[var(--sf-text-1)] disabled:opacity-60"
                />
              ) : (
                <input
                  type="text"
                  disabled={!interactive || busy}
                  value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  className="h-8 rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-2 text-[13px] text-[var(--sf-text-1)] disabled:opacity-60"
                />
              )
            ) : null}
            {field.type === "number" ? (
              <input
                type="number"
                step={field.integer ? 1 : "any"}
                disabled={!interactive || busy}
                value={typeof values[field.id] === "number" ? (values[field.id] as number) : ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  setValues((current) => ({
                    ...current,
                    [field.id]: raw === "" ? undefined : Number(raw),
                  }));
                }}
                className="h-8 rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-2 text-[13px] text-[var(--sf-text-1)] disabled:opacity-60"
              />
            ) : null}
            {field.type === "boolean" ? (
              <input
                type="checkbox"
                disabled={!interactive || busy}
                checked={Boolean(values[field.id] ?? fieldDefaults[field.id])}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.checked }))}
                className="size-4"
              />
            ) : null}
            {field.type === "select" ? (
              <select
                disabled={!interactive || busy}
                value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                className="h-8 rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-2 text-[13px] text-[var(--sf-text-1)] disabled:opacity-60"
              >
                <option value="">Choose…</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
            {issue ? <span className="text-[12px] text-[var(--sf-fail)]">{issue}</span> : null}
          </label>
        );
      })}
      {issues.form ? <p className="m-0 text-[12px] text-[var(--sf-fail)]">{issues.form}</p> : null}
      {interactive ? (
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 self-start rounded-md bg-[var(--sf-text-1)] px-3 text-[12px] font-medium text-[var(--sf-ground)] disabled:opacity-50"
        >
          <LuSend aria-hidden className="size-3.5" />
          Submit
        </button>
      ) : submitted ? (
        <p className="m-0 text-[12px] text-[var(--sf-text-2)]">Submitted.</p>
      ) : (
        <p className="m-0 text-[12px] text-[var(--sf-text-3)]">{form.fallback.text}</p>
      )}
    </form>
  );
}

let registered = false;

export function ensureFormPartRegistered(): void {
  if (registered) return;
  registerUiPart(UI_PART_KIND_FORM, FormPart);
  registered = true;
}