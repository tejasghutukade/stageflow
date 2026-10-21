import type { z } from "zod";
import { ChannelError } from "../errors.js";
import type { ConnectionHealth, SendReceipt, ValidationResult } from "../types.js";

/**
 * Adapter helpers that every provider shares. Each one owns a rule that used to be copied into
 * each adapter and had started to drift (for example how an unexpected error in a check is
 * retried). Adapters keep only what makes them different: the protocol of their own send.
 */

/** Turns a zod schema into a `ValidationResult`, naming the failing paths or `root` when there is none. */
export function zodValidator<S extends z.ZodType, V = z.infer<S>>(
  schema: S,
  root: string,
  normalize?: (data: z.infer<S>) => V,
): (input: unknown) => ValidationResult<V> {
  return input => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(issue => issue.path.join(".") || root) };
    return { ok: true, value: normalize ? normalize(parsed.data) : (parsed.data as unknown as V) };
  };
}

/**
 * Runs a live check. `run` returns when the connection works and throws a `ChannelError` for a
 * definite failure. Any other error is treated as a transient connection failure, for every
 * provider alike, because run start retries only failures marked retryable.
 */
export async function healthOf(run: () => Promise<void>): Promise<ConnectionHealth> {
  const checkedAt = new Date().toISOString();
  try {
    await run();
    return { state: "ok", checkedAt };
  } catch (error) {
    const failure = error instanceof ChannelError ? error : new ChannelError("CHANNEL_CONNECTION_FAILED", true);
    return { state: "failed", checkedAt, error: { code: failure.code, retryable: failure.retryable } };
  }
}

/** The receipt for an accepted send. A provider that accepted it but returned no id still counts as accepted, with a warning. */
export function receiptFor(messageId: string | undefined): SendReceipt {
  return {
    ...(messageId !== undefined ? { providerMessageId: messageId } : {}),
    submittedAt: new Date().toISOString(),
    ...(messageId === undefined ? { warnings: ["CHANNEL_RESPONSE_UNPARSEABLE"] } : {}),
  };
}

/** Bounds a send that has no timeout of its own. Expiry is an unknown outcome: the send may have gone out. */
export async function withSendTimeout<T>(ms: number, connectionId: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId })), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export type SpectrumImporter = (specifier: string) => Promise<any>;
export const importModule: SpectrumImporter = specifier => import(specifier);

export type SpectrumPlatformRef = {
  /** npm package of the platform, such as `@spectrum-ts/imessage`. */
  pkg: string;
  /** Name of its export, such as `imessage`. */
  exportName: string;
};

/**
 * The Spectrum SDK lifecycle for one send: load the packages on first use (so a host that never
 * sends over Photon does not need them), create the app, hand the platform to `run`, and always
 * stop the app. Nothing stays connected between sends. A missing package is
 * `CHANNEL_PROVIDER_UNSUPPORTED`; a failure to stop never hides the send's own result.
 */
export async function withSpectrumApp<T>(
  importer: SpectrumImporter,
  credentials: { projectId: string; projectSecret: string },
  platform: SpectrumPlatformRef,
  run: (app: { platform: any; module: any }) => Promise<T>,
): Promise<T> {
  let core: any;
  let module: any;
  try {
    core = await importer("@spectrum-ts/core");
    module = await importer(platform.pkg);
  } catch {
    throw new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED");
  }
  const exported = module[platform.exportName];
  const app = await core.Spectrum({ projectId: credentials.projectId, projectSecret: credentials.projectSecret, providers: [exported.config()] });
  try {
    return await run({ platform: exported(app), module });
  } finally {
    await app.stop().catch(() => undefined);
  }
}
