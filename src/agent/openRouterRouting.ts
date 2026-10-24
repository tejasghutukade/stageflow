import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

type RoutedPayload = { tools?: unknown; provider?: unknown } & Record<string, unknown>;

function isOpenRouter(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  return model?.provider === "openrouter" || (typeof model?.baseUrl === "string" && model.baseUrl.includes("openrouter.ai"));
}

/**
 * OpenRouter load-balances a model across providers, and providers differ in tool-call support. On any
 * request that carries tools, ask OpenRouter to skip providers that cannot honour them. Routing the Host
 * set in models.json (`openRouterRouting`) wins over this default.
 */
export function createOpenRouterRoutingExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
      const payload = event.payload as RoutedPayload | null;
      if (payload === null || typeof payload !== "object") return undefined;
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return undefined;
      if (!isOpenRouter((ctx as unknown as { model?: { provider?: string; baseUrl?: string } }).model)) return undefined;
      const existing = payload.provider !== null && typeof payload.provider === "object" ? (payload.provider as Record<string, unknown>) : {};
      return { ...payload, provider: { require_parameters: true, ...existing } };
    });
  };
}
