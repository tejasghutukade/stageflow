import { useEffect, useMemo, useState } from "react";
import { LuMenu, LuX } from "react-icons/lu";
import { createChatApi, ChatApiError, type ChatAgentInfo } from "./api";
import { ChatRuntimeProvider } from "./ChatRuntime";
import { readChatConfig } from "./config";
import { UNAVAILABLE_CODE } from "./errors";
import { Thread } from "./Thread";
import { ThreadSidebar } from "./ThreadSidebar";
import { getVisitorId } from "./visitor";

type Load = { state: "loading" } | { state: "ready"; agent: ChatAgentInfo } | { state: "unavailable" } | { state: "error" };

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--sf-ground)] px-6 text-center">
      <h1 className="m-0 text-xl font-semibold text-[var(--sf-text-1)]">{title}</h1>
      <p className="m-0 max-w-sm text-[15px] text-[var(--sf-text-2)]">{body}</p>
    </main>
  );
}

function Unavailable() {
  return <Centered title="This chat isn't available" body="The link may have changed or the assistant is offline. Check with whoever shared it." />;
}

export function ChatApp() {
  const config = useMemo(() => readChatConfig(), []);
  const api = useMemo(
    () => (config.slug ? createChatApi({ apiBase: config.apiBase, slug: config.slug, visitorId: getVisitorId() }) : null),
    [config],
  );
  const [load, setLoad] = useState<Load>(api ? { state: "loading" } : { state: "unavailable" });
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.info().then(
      (agent) => live && setLoad({ state: "ready", agent }),
      (error: unknown) => live && setLoad(error instanceof ChatApiError && error.code === UNAVAILABLE_CODE ? { state: "unavailable" } : { state: "error" }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    document.title = load.state === "ready" ? load.agent.name : "Chat";
  }, [load]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (!api || load.state === "unavailable") return <Unavailable />;
  if (load.state === "loading") return <div className="h-full bg-[var(--sf-ground)]" aria-busy="true" />;
  if (load.state === "error") return <Centered title="We couldn't load this chat" body="Please check your connection and refresh the page." />;

  const { agent } = load;
  return (
    <ChatRuntimeProvider api={api}>
      <div className="flex h-full bg-[var(--sf-ground)] text-[var(--sf-text-1)]">
        {drawer ? <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={() => setDrawer(false)} aria-hidden /> : null}
        <aside
          aria-label="Conversations"
          className={`fixed inset-y-0 left-0 z-30 w-72 border-r border-[var(--sf-hairline)] bg-[var(--sf-rail)] transition-transform md:static md:translate-x-0 ${
            drawer ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <button
            type="button"
            aria-label="Close conversations"
            onClick={() => setDrawer(false)}
            className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-lg text-[var(--sf-text-2)] md:hidden"
          >
            <LuX aria-hidden className="size-4" />
          </button>
          <ThreadSidebar agentName={agent.name} onPick={() => setDrawer(false)} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--sf-hairline)] px-3 md:hidden">
            <button
              type="button"
              aria-label="Open conversations"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
              className="flex size-8 items-center justify-center rounded-lg text-[var(--sf-text-2)]"
            >
              <LuMenu aria-hidden className="size-5" />
            </button>
            <span className="truncate text-sm font-semibold">{agent.name}</span>
          </header>
          <main className="min-h-0 flex-1">
            <Thread agentName={agent.name} greeting={agent.greeting} />
          </main>
        </div>
      </div>
    </ChatRuntimeProvider>
  );
}
