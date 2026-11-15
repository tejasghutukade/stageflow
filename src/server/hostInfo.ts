import { normalizePublicUrl } from "../a2a/registry.js";
import { isHostedConsole } from "./hostedConsole.js";

export type HostInfo = {
  hosted: boolean;
  managed: boolean;
  publicUrl: string | null;
  publicChatUrl: string | null;
};

function originFrom(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  try {
    return normalizePublicUrl(value.trim());
  } catch {
    return null;
  }
}

/**
 * Where people outside this machine reach the Host. `STAGEFLOW_PUBLIC_URL` is the console, API and MCP address;
 * `STAGEFLOW_PUBLIC_CHAT_URL` is the address of public web chat when it is served from another origin than the console.
 * An invalid value is ignored here (A2A still rejects it where it is used), so the console falls back to the browser's own address.
 */
export function resolveHostInfo(env: NodeJS.ProcessEnv = process.env): HostInfo {
  const publicUrl = originFrom(env.STAGEFLOW_PUBLIC_URL);
  return {
    hosted: isHostedConsole(env),
    managed: (env.STAGEFLOW_PLATFORM_URL ?? "").trim() !== "",
    publicUrl,
    publicChatUrl: originFrom(env.STAGEFLOW_PUBLIC_CHAT_URL) ?? null,
  };
}
