import { isLoopbackHostname } from "./allowedHosts.js";
import { resolveListenHost } from "./listenHost.js";

/**
 * True when this process is serving a console a remote browser can open.
 * Cloud VMs set `STAGEFLOW_ALLOWED_HOSTS` and a non-loopback `STAGEFLOW_BIND`
 * in `/etc/stageflow/host.local.env`. A local `sf ui` leaves both unset, so
 * the browser and the OAuth callback share a machine.
 */
export function isHostedConsole(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return allowedHostsImplyRemote(env) || bindIsRemote(env);
}

function allowedHostsImplyRemote(env: NodeJS.ProcessEnv): boolean {
  const raw = env.STAGEFLOW_ALLOWED_HOSTS;
  if (raw === undefined || raw.trim() === "") return false;
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length === 0) continue;
    if (token === "*") return true;
    const hostname = hostnameOfAllowedToken(token);
    if (!isLoopbackHostname(hostname)) return true;
  }
  return false;
}

function hostnameOfAllowedToken(token: string): string {
  if (token.startsWith("[")) {
    const end = token.indexOf("]");
    if (end === -1) return token.toLowerCase();
    return token.slice(1, end).toLowerCase();
  }
  const colon = token.lastIndexOf(":");
  if (colon > 0) {
    const tail = token.slice(colon + 1);
    const head = token.slice(0, colon);
    if (/^\d+$/.test(tail) && !head.includes(":")) {
      return head.toLowerCase();
    }
  }
  return token.toLowerCase();
}

function bindIsRemote(env: NodeJS.ProcessEnv): boolean {
  const raw = env.STAGEFLOW_BIND;
  if (raw === undefined || raw.trim() === "") return false;
  try {
    return !isLoopbackHostname(resolveListenHost({ env }));
  } catch {
    return false;
  }
}
