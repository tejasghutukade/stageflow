import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvalApiError,
  evalQueryString,
  evalRunExportUrl,
  fetchEvalDatasetCandidates,
  fetchEvalRunEstimate,
  putEvalReview,
  startEvalRun,
  updateEval,
} from "./evalsClient";

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eval api client", () => {
  it("builds query strings, dropping empty values and joining lists", () => {
    expect(evalQueryString({})).toBe("");
    expect(evalQueryString({ a: "x", b: undefined, c: "", d: ["1", "2"], e: 3 })).toBe("?a=x&d=1%2C2&e=3");
  });

  it("posts a run start and returns the body", async () => {
    const calls = stubFetch(202, { eval_run_id: "er_1", status: "queued", run_number: 1 });
    const result = await startEvalRun("my eval", { repeats: 2, label: "try" });
    expect(result.eval_run_id).toBe("er_1");
    expect(calls[0]!.url).toBe("/api/evals/my%20eval/runs");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ repeats: 2, label: "try" });
  });

  it("sends estimate options as query parameters", async () => {
    const calls = stubFetch(200, {});
    await fetchEvalRunEstimate("e1", { repeats: 3, case_ids: ["a", "b"], project_root: "/p" });
    expect(calls[0]!.url).toBe("/api/evals/e1/runs/estimate?repeats=3&case_ids=a%2Cb&project_root=%2Fp");
  });

  it("puts a review at the repeat-scoped path", async () => {
    const calls = stubFetch(200, { label: "fail", note: null, tags: ["x"] });
    await putEvalReview("er_1", "c 1", 2, { label: "fail", tags: ["x"] });
    expect(calls[0]!.url).toBe("/api/eval-runs/er_1/results/c%201/2/review");
    expect(calls[0]!.init.method).toBe("PUT");
  });

  it("maps target fields and options for dataset candidates and the export url", async () => {
    const calls = stubFetch(200, { items: [] });
    await fetchEvalDatasetCandidates({ pipeline_path: "p.yaml", stage_id: "s" }, { limit: 5 });
    expect(calls[0]!.url).toBe("/api/datasets/candidates?pipeline_path=p.yaml&stage_id=s&limit=5");
    expect(evalRunExportUrl("er_1", "config")).toBe("/api/eval-runs/er_1/export?what=config");
  });

  it("raises EvalApiError with code, findings and current hash", async () => {
    stubFetch(409, { error: "changed", code: "FILE_CHANGED", current_hash: "abc" });
    const err = await updateEval("e1", { base_hash: "old", yaml: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalApiError);
    expect(err).toMatchObject({ status: 409, code: "FILE_CHANGED", currentHash: "abc", message: "changed" });

    stubFetch(422, { error: "bad", code: "EVAL_INVALID", findings: [{ code: "x" }] });
    const invalid = (await updateEval("e1", { base_hash: "h", yaml: "x" }).catch((e: unknown) => e)) as EvalApiError;
    expect(invalid.findings).toHaveLength(1);

    stubFetch(500, {});
    const generic = (await startEvalRun("e1").catch((e: unknown) => e)) as EvalApiError;
    expect(generic.code).toBe("HTTP_500");
  });
});
