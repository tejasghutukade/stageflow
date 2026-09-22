import { isIP } from "node:net";

const DEFAULT_BIND = "127.0.0.1";

export function resolveListenHost(options: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  let raw: string | undefined;
  if (options.flag !== undefined) {
    raw = options.flag;
  } else if (env.STAGEFLOW_BIND !== undefined) {
    raw = env.STAGEFLOW_BIND;
  }
  if (raw === undefined) {
    return DEFAULT_BIND;
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(
      `Invalid --host / STAGEFLOW_BIND value: ${JSON.stringify(raw)}. Use an IPv4 or IPv6 literal, 0.0.0.0, or ::.`,
    );
  }
  const normalized = unwrapIpv6Brackets(value);
  if (
    value.includes("://") ||
    value.includes("/") ||
    looksLikeHostPort(value) ||
    isIP(normalized) === 0
  ) {
    throw new Error(
      `Invalid --host / STAGEFLOW_BIND value: ${JSON.stringify(value)}. Use an IPv4 or IPv6 literal, 0.0.0.0, or ::.`,
    );
  }
  return normalized;
}

export function advertisedHost(bind: string): string {
  if (bind === "0.0.0.0") return "127.0.0.1";
  if (bind === "::") return "[::1]";
  if (isIP(bind) === 6) return `[${bind}]`;
  return bind;
}

function unwrapIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikeHostPort(value: string): boolean {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return false;
    const rest = value.slice(end + 1);
    return rest.startsWith(":") && rest.length > 1;
  }
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return false;
  const maybePort = value.slice(colon + 1);
  return /^\d+$/.test(maybePort) && isIP(value.slice(0, colon)) !== 0;
}
