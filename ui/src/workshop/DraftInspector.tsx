import { useEffect, useState } from "react";
import type { DraftPackage } from "./draft";
import { draftStageIds } from "./draft";
import {
  patchPipelineMeta,
  patchPipelineStageRef,
  patchStageBody,
  readStageBody,
  rewireStageRoute,
} from "./draftEdits";

export type InspectorSelection =
  | { kind: "pipeline" }
  | { kind: "stage"; stageId: string };

type StageGateKind =
  | "free_text"
  | "confirm"
  | "multi_question"
  | "artifact_backed";

const GATE_KINDS: StageGateKind[] = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringifyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function gateKindsFromBody(body: Record<string, unknown>): StageGateKind[] | null {
  if (!("gate_kinds" in body)) return null;
  if (!Array.isArray(body.gate_kinds)) return [];
  return body.gate_kinds.filter(
    (k): k is StageGateKind =>
      typeof k === "string" && (GATE_KINDS as string[]).includes(k),
  );
}

function JsonField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: unknown;
  onCommit: (next: unknown | undefined) => void;
}) {
  const [text, setText] = useState(() => stringifyJson(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(stringifyJson(value));
    setError(null);
  }, [value]);

  return (
    <label className="workshop__field">
      {label}
      <textarea
        className="input mono"
        rows={label.startsWith("io") ? 6 : 4}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const trimmed = next.trim();
          if (!trimmed) {
            setError(null);
            onCommit(undefined);
            return;
          }
          try {
            onCommit(JSON.parse(trimmed) as unknown);
            setError(null);
          } catch {
            setError("Invalid JSON");
          }
        }}
      />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function DraftInspector({
  draft,
  selection,
  onChange,
  onRemoveStage,
}: {
  draft: DraftPackage;
  selection: InspectorSelection | null;
  onChange: (next: DraftPackage) => void;
  onRemoveStage?: (stageId: string) => void;
}) {
  if (!selection) {
    return (
      <div className="workshop__inspector">
        <div className="eyebrow">Inspector</div>
        <p className="empty-hint">
          Select the pipeline header or a stage on the DAG to edit core fields.
        </p>
      </div>
    );
  }

  if (selection.kind === "pipeline") {
    return (
      <div className="workshop__inspector">
        <div className="eyebrow">Pipeline</div>
        <label className="workshop__field">
          Id
          <input
            className="input"
            value={draft.pipeline.id}
            onChange={(e) =>
              onChange(patchPipelineMeta(draft, { id: e.target.value }))
            }
          />
        </label>
        <label className="workshop__field">
          Model
          <input
            className="input"
            value={asString(draft.pipeline.model)}
            placeholder="Optional package default"
            onChange={(e) =>
              onChange(
                patchPipelineMeta(draft, {
                  model: e.target.value.trim() || undefined,
                }),
              )
            }
          />
        </label>
      </div>
    );
  }

  const stageId = selection.stageId;
  const body = readStageBody(draft, stageId);
  const refIndex = draft.pipeline.stages.findIndex(
    (stage, index) =>
      (typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`) ===
      stageId,
  );
  const ref = refIndex >= 0 ? draft.pipeline.stages[refIndex]! : null;
  if (!body || !ref) {
    return (
      <div className="workshop__inspector">
        <div className="eyebrow">Inspector</div>
        <p className="empty-hint">Stage “{stageId}” is not in the draft.</p>
      </div>
    );
  }

  const gateKinds = gateKindsFromBody(body);
  const routeTo =
    Array.isArray(ref.route) &&
    ref.route[0] !== null &&
    typeof ref.route[0] === "object" &&
    "to" in (ref.route[0] as object)
      ? asString((ref.route[0] as { to?: unknown }).to)
      : "";
  const otherIds = draftStageIds(draft).filter((id) => id !== stageId);

  return (
    <div className="workshop__inspector">
      <div className="eyebrow">Stage · {stageId}</div>
      <label className="workshop__field">
        System prompt
        <textarea
          className="input"
          rows={4}
          value={asString(body.system_prompt)}
          onChange={(e) =>
            onChange(patchStageBody(draft, stageId, { system_prompt: e.target.value }))
          }
        />
      </label>
      <label className="workshop__field">
        Model
        <input
          className="input"
          value={asString(body.model)}
          onChange={(e) =>
            onChange(patchStageBody(draft, stageId, { model: e.target.value }))
          }
        />
      </label>
      <JsonField
        label="io (JSON)"
        value={body.io}
        onCommit={(parsed) =>
          onChange(patchStageBody(draft, stageId, { io: parsed }))
        }
      />
      <JsonField
        label="verify (JSON)"
        value={body.verify}
        onCommit={(parsed) =>
          onChange(patchStageBody(draft, stageId, { verify: parsed }))
        }
      />
      <label className="workshop__field">
        on_verify_fail
        <input
          className="input"
          value={asString(body.on_verify_fail)}
          placeholder="e.g. retry or fail"
          onChange={(e) =>
            onChange(
              patchStageBody(draft, stageId, {
                on_verify_fail: e.target.value.trim() || undefined,
              }),
            )
          }
        />
      </label>
      <fieldset className="workshop__field">
        <legend>HITL gate_kinds</legend>
        <label className="workshop__check">
          <input
            type="radio"
            name={`gate-mode-${stageId}`}
            checked={gateKinds === null}
            onChange={() => {
              onChange(
                patchStageBody(draft, stageId, { gate_kinds: undefined }),
              );
            }}
          />
          All kinds (omit field)
        </label>
        <label className="workshop__check">
          <input
            type="radio"
            name={`gate-mode-${stageId}`}
            checked={gateKinds !== null && gateKinds.length === 0}
            onChange={() =>
              onChange(patchStageBody(draft, stageId, { gate_kinds: [] }))
            }
          />
          No HITL (`[]`)
        </label>
        <label className="workshop__check">
          <input
            type="radio"
            name={`gate-mode-${stageId}`}
            checked={gateKinds !== null && gateKinds.length > 0}
            onChange={() =>
              onChange(
                patchStageBody(draft, stageId, {
                  gate_kinds: gateKinds?.length ? gateKinds : ["free_text"],
                }),
              )
            }
          />
          Allowlist
        </label>
        {GATE_KINDS.map((kind) => (
          <label key={kind} className="workshop__check">
            <input
              type="checkbox"
              disabled={gateKinds === null}
              checked={gateKinds?.includes(kind) ?? false}
              onChange={(e) => {
                const current = gateKinds ?? [];
                const next = e.target.checked
                  ? [...new Set([...current, kind])]
                  : current.filter((k) => k !== kind);
                onChange(patchStageBody(draft, stageId, { gate_kinds: next }));
              }}
            />
            {kind}
          </label>
        ))}
      </fieldset>
      <label className="workshop__check">
        <input
          type="checkbox"
          checked={ref.entry === true}
          onChange={(e) =>
            onChange(
              patchPipelineStageRef(draft, stageId, {
                entry: e.target.checked ? true : undefined,
              }),
            )
          }
        />
        Entry stage
      </label>
      <label className="workshop__field">
        Route to
        <select
          className="input"
          value={routeTo}
          onChange={(e) =>
            onChange(
              rewireStageRoute(
                draft,
                stageId,
                e.target.value ? e.target.value : null,
              ),
            )
          }
        >
          <option value="">(none)</option>
          {otherIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {onRemoveStage ? (
        <button
          type="button"
          className="btn"
          onClick={() => onRemoveStage(stageId)}
        >
          Remove stage
        </button>
      ) : null}
    </div>
  );
}
