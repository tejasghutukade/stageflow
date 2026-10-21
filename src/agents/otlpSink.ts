export type OtlpSink = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Collector from the standard OTel environment (`OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `..._TRACES_ENDPOINT`, plus `OTEL_EXPORTER_OTLP_HEADERS`). Undefined when none
 * is configured, so `observability.otlp` is a no-op without a destination.
 */
export function otlpSinkFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): OtlpSink | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = traces || (base ? `${base.replace(/\/$/, "")}/v1/traces` : undefined);
  if (!url) return undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return async (payload) => {
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OTLP collector responded ${res.status}`);
  };
}
