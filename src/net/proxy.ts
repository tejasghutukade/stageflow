import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { stripUrlUserinfo } from "../logging/redact.js";

export type ProxyInstallResult = {
  installed: boolean;
  httpProxyHost?: string;
  httpsProxyHost?: string;
  noProxy: string;
};

let installed = false;

function firstProxy(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    undefined
  );
}

function parseProxyHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.host;
  } catch {
    return stripUrlUserinfo(raw);
  }
}

export function effectiveNoProxy(
  env: NodeJS.ProcessEnv,
  bindHosts: readonly string[] = ["127.0.0.1", "::1", "localhost"],
): string {
  const existing = env.NO_PROXY ?? env.no_proxy ?? "";
  const parts = existing
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(parts.map((p) => p.toLowerCase()));
  for (const host of bindHosts) {
    if (!set.has(host.toLowerCase())) {
      parts.push(host);
      set.add(host.toLowerCase());
    }
  }
  return parts.join(",");
}

export function installProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env,
  options: { bindHosts?: readonly string[]; log?: (msg: string) => void } = {},
): ProxyInstallResult {
  const proxy = firstProxy(env);
  if (!proxy) {
    return { installed: false, noProxy: env.NO_PROXY ?? env.no_proxy ?? "" };
  }
  const noProxy = effectiveNoProxy(env, options.bindHosts);
  process.env.NO_PROXY = noProxy;
  if (!installed) {
    setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy }));
    installed = true;
    options.log?.(
      `Installed EnvHttpProxyAgent; appended loopback to NO_PROXY (${noProxy})`,
    );
  }
  return {
    installed: true,
    httpProxyHost: parseProxyHost(env.HTTP_PROXY ?? env.http_proxy),
    httpsProxyHost: parseProxyHost(env.HTTPS_PROXY ?? env.https_proxy),
    noProxy,
  };
}

export function resetProxyDispatcherForTests(): void {
  installed = false;
}

export function buildEgressHealth(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const httpSet = Boolean(env.HTTP_PROXY || env.http_proxy);
  const httpsSet = Boolean(env.HTTPS_PROXY || env.https_proxy);
  const noProxySet = Boolean(env.NO_PROXY || env.no_proxy);
  const caSet = Boolean(
    env.NODE_EXTRA_CA_CERTS || env.SSL_CERT_FILE || env.REQUESTS_CA_BUNDLE,
  );
  const proxyHost =
    parseProxyHost(env.HTTPS_PROXY ?? env.https_proxy) ??
    parseProxyHost(env.HTTP_PROXY ?? env.http_proxy) ??
    null;
  return {
    http_proxy: httpSet ? "set" : "unset",
    https_proxy: httpsSet ? "set" : "unset",
    no_proxy: noProxySet ? "set" : "unset",
    proxy_host: proxyHost,
    extra_ca_certs: caSet ? "set" : "unset",
    dispatcher_installed: installed,
  };
}

export function proxyHealthFields(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return buildEgressHealth(env);
}
