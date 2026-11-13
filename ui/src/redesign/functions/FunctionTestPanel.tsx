import { useEffect, useRef, useState } from "react";
import { LuCheck, LuPlay, LuTriangleAlert, LuX } from "react-icons/lu";
import { FunctionApiError, functionsApi, type FunctionInvocation, type FunctionKind, type FunctionRunView } from "../../api/functions";
import { MONO, NOWRAP } from "../agents/agentsTokens";
import { Button, ListGroup, Toggle } from "../agents/ui";
import { Callout, CodeArea } from "./FunctionFields";
import { relativeTime } from "./functionKinds";
import {
  applyTestErrorResponse,
  applyTestRunResponse,
  clearedTestPanelState,
  functionGenerationIsCurrent,
  nextFunctionGeneration,
  shouldClearTestPanel,
  testPanelGenerationKey,
  testRequestBody,
} from "./functionsPageModel";

type Tone = "ok" | "fail" | "needs";

const TONE: Record<Tone, string> = {
  ok: "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]",
  fail: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
  needs: "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)]",
};

function toneOf(status: string): Tone {
  if (status === "succeeded") return "ok";
  if (status === "uncertain") return "needs";
  return "fail";
}

function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs leading-[1.33333] ${NOWRAP} ${TONE[tone]}`}>
      {tone === "ok" ? <LuCheck aria-hidden className="size-3" /> : tone === "needs" ? <LuTriangleAlert aria-hidden className="size-3" /> : <LuX aria-hidden className="size-3" />}
      {label}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = { succeeded: "Succeeded", failed: "Failed", uncertain: "Uncertain" };

function statusLabel(status: string, code: string | null | undefined): string {
  const base = STATUS_LABEL[status] ?? status;
  return code && status !== "succeeded" ? `${base} · ${code}` : base;
}

function Output({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{label}</span>
      <pre
        className={`${MONO} max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-3 py-2 text-xs leading-[1.6] text-[var(--sf-text-1)]`}
      >
        {children}
      </pre>
    </div>
  );
}

const SAMPLE_CONTEXT: Record<FunctionKind, { text: string; hint: string }> = {
  verification: {
    text: "{\n}",
    hint: "A verification reads files and environment values through context, so an empty object is usually enough.",
  },
  routing: {
    text: '{\n  "envelope": { "payload": {} },\n  "children": [{ "id": "next" }]\n}',
    hint: "A routing function receives the verified envelope and the eligible next stages as children.",
  },
  tool: {
    text: '{\n  "input": {}\n}',
    hint: "A tool receives the agent's arguments as context.input, so put them under an input key.",
  },
};

export function FunctionTestPanel({
  functionId,
  kind,
  source,
  savedSource,
  onRan,
}: {
  functionId?: string;
  kind: FunctionKind;
  source: string;
  savedSource?: string;
  onRan: () => void;
}) {
  const [real, setReal] = useState(false);
  const [sampleInput, setSampleInput] = useState(SAMPLE_CONTEXT[kind].text);
  const [run, setRun] = useState<FunctionRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const testGenerationRef = useRef(0);
  const testGenerationKeyRef = useRef(
    testPanelGenerationKey({ source, savedSource, functionId, kind }),
  );

  useEffect(() => {
    const nextKey = testPanelGenerationKey({ source, savedSource, functionId, kind });
    if (!shouldClearTestPanel(testGenerationKeyRef.current, nextKey)) return;
    testGenerationKeyRef.current = nextKey;
    nextFunctionGeneration(testGenerationRef);
    const cleared = clearedTestPanelState();
    setRun(cleared.run);
    setError(cleared.error);
    setBusy(cleared.busy);
  }, [source, savedSource, functionId, kind]);

  let inputError: string | null = null;
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(sampleInput) as unknown;
  } catch {
    inputError = "Sample context must be valid JSON.";
  }

  const testingUnsaved = functionId !== undefined && savedSource !== undefined && source !== savedSource;

  async function runTest() {
    if (!functionId || inputError) return;
    const generation = testGenerationRef.current;
    setBusy(true);
    setError(null);
    try {
      const body = testRequestBody({ source: testingUnsaved ? source : undefined, input: parsed, real });
      const result = await functionsApi.test(functionId, body);
      const applied = applyTestRunResponse(generation, testGenerationRef, result);
      if (applied !== null) setRun(applied);
      if (applied !== null) onRan();
    } catch (err) {
      const message = err instanceof FunctionApiError || err instanceof Error ? err.message : String(err);
      const appliedError = applyTestErrorResponse(generation, testGenerationRef, message);
      if (appliedError !== null) {
        setRun(null);
        setError(appliedError);
      }
    } finally {
      if (functionGenerationIsCurrent(generation, testGenerationRef)) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="function-test-panel">
      <div className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-3 ${real ? "border-[var(--sf-needs-border)] bg-[var(--sf-needs-bg)]" : "border-[var(--sf-hairline)]"}`}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Use real files, environment, and APIs</span>
          <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
            {real
              ? "This run reads the real files, uses real environment values and makes real API calls, including any action you granted."
              : "Tests use mock files, environment values and API responses. Turning this on applies to the next run only; it is not remembered."}
          </span>
        </div>
        <Toggle on={real} onChange={setReal} label="Use real files, environment, and APIs" />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Sample context</span>
        <CodeArea ariaLabel="Sample context" value={sampleInput} onChange={setSampleInput} rows={5} invalid={inputError !== null} />
        {inputError ? (
          <span className="text-xs leading-[1.33333] text-[var(--sf-fail)]">{inputError}</span>
        ) : (
          <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Passed to execute as context. {SAMPLE_CONTEXT[kind].hint}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon={<LuPlay aria-hidden />} disabled={busy || !functionId || inputError !== null} onClick={() => void runTest()}>
          {busy ? "Running…" : "Run test"}
        </Button>
        <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
          {!functionId ? "Save the function first to run a test." : testingUnsaved ? "Runs your unsaved source. Nothing is saved." : "Runs the saved revision."}
        </span>
      </div>

      {error ? (
        <Callout tone="fail" role="alert">
          <span>{error}</span>
        </Callout>
      ) : null}

      {run ? (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--sf-hairline)] p-4" data-testid="function-test-result">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={toneOf(run.status)} label={statusLabel(run.status, run.code)} />
            <span className={`${MONO} text-xs text-[var(--sf-text-2)]`}>{run.durationMs} ms</span>
            <span className="text-xs text-[var(--sf-text-3)]">{run.revision === null ? "Unsaved source" : `Revision ${run.revision}`}</span>
          </div>
          {run.message ? (
            <p className="flex items-start gap-2 text-[13px] leading-normal text-[var(--sf-text-1)]">
              {run.status === "succeeded" ? null : <LuTriangleAlert aria-hidden className={`mt-0.5 size-3.5 shrink-0 ${run.status === "uncertain" ? "text-[var(--sf-needs)]" : "text-[var(--sf-fail)]"}`} />}
              {run.message}
            </p>
          ) : null}
          {run.value !== undefined ? <Output label="Result">{JSON.stringify(run.value, null, 2)}</Output> : null}
          {run.logs ? <Output label="Logs">{run.logs}</Output> : null}
        </div>
      ) : null}
    </div>
  );
}

export function FunctionHistory({ invocations }: { invocations: FunctionInvocation[] }) {
  if (invocations.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-3.5 py-3 text-xs leading-normal text-[var(--sf-text-3)]">
        No runs yet. Tests and real calls from stages and agents are listed here.
      </div>
    );
  }
  return (
    <ListGroup>
      {invocations.map((row) => {
        return (
          <div key={row.id} className="flex items-center gap-3 px-3 py-2.5">
            <StatusPill tone={toneOf(row.status)} label={statusLabel(row.status, row.code)} />
            <span className="min-w-0 flex-1 truncate text-xs leading-[1.33333] text-[var(--sf-text-2)]">
              {row.kind} · {row.revision === null ? "unsaved source" : `revision ${row.revision}`}
            </span>
            <span className={`${MONO} shrink-0 text-xs text-[var(--sf-text-3)]`}>{row.durationMs} ms</span>
            <span className="w-16 shrink-0 text-right text-xs text-[var(--sf-text-3)]" title={row.createdAt}>
              {relativeTime(row.createdAt)}
            </span>
          </div>
        );
      })}
    </ListGroup>
  );
}
