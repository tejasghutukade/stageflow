/**
 * Where the page finds its agent and API. Everything is read at runtime so the same build can be
 * hosted by the Stageflow Host (`/chat/<slug>`, same-origin API) or deployed elsewhere with an
 * explicit `window.__STAGEFLOW_CHAT__ = { apiBase, slug }`.
 */
export type ChatConfig = { slug: string | null; apiBase: string };

type ChatWindow = {
  __STAGEFLOW_CHAT__?: { apiBase?: string; slug?: string };
  location: { pathname: string };
  document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
};

export const DEFAULT_API_BASE = "/api/public/chat";

export function readChatConfig(win: ChatWindow = window as unknown as ChatWindow): ChatConfig {
  const injected = win.__STAGEFLOW_CHAT__;
  const meta = win.document.querySelector('meta[name="stageflow-chat-api"]')?.getAttribute("content")?.trim();
  const apiBase = (injected?.apiBase?.trim() || meta || DEFAULT_API_BASE).replace(/\/+$/, "");
  const fromPath = /^\/chat\/([^/?#]+)/.exec(win.location.pathname)?.[1];
  const slug = injected?.slug?.trim() || (fromPath ? safeDecode(fromPath) : null);
  return { slug: slug && slug.length > 0 ? slug : null, apiBase };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
