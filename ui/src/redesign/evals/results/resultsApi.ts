import { authorizationHeaders } from "../../../api/controlToken";
import { evalRunExportUrl } from "../../../api/evalsClient";
import type { EvalResultDetail, EvalRunDetail } from "../../../api/evalTypes";
import { exportFileName } from "./configModel";

export type RunExport = EvalRunDetail & { results: EvalResultDetail[] };

async function fetchExportText(evalRunId: string, what: "results" | "config"): Promise<string> {
  const res = await fetch(evalRunExportUrl(evalRunId, what), { headers: authorizationHeaders() });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  return res.text();
}

export async function fetchRunExport(evalRunId: string): Promise<RunExport> {
  return JSON.parse(await fetchExportText(evalRunId, "results")) as RunExport;
}

export async function downloadRunExport(
  run: Pick<EvalRunDetail, "eval_run_id" | "eval_id" | "run_number">,
  what: "results" | "config",
): Promise<void> {
  const text = await fetchExportText(run.eval_run_id, what);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFileName(run, what);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
