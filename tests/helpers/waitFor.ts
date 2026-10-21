export type WaitForOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
};

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: number | WaitForOptions = {},
): Promise<void> {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const intervalMs = opts.intervalMs ?? 20;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(opts.message ?? "timeout waiting for condition");
}
