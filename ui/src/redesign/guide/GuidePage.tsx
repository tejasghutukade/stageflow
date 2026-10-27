import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../shell/PageHeader";
import { createGuideApi } from "./api";
import { GuideSidebar } from "./GuideSidebar";
import { GuideThread } from "./GuideThread";
import { GuideRuntime } from "./runtime";
import { navigate, guidePath } from "../../routes";

const FALLBACK_NAME = "Stageflow";
const FALLBACK_GREETING = "Tell me what you want to get done. I'll help you decide what to build.";

function GuideMissing() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h2 className="m-0 text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">That section isn't part of Guide</h2>
      <p className="m-0 max-w-sm text-[15px] leading-relaxed text-[var(--sf-text-2)]">Chat is where you talk with Stageflow about what to build.</p>
      <a
        href={`#${guidePath("chat")}`}
        className="rounded-lg bg-[var(--sf-text-1)] px-3 py-2 text-[13px] font-medium text-[var(--sf-ground)] no-underline"
        onClick={(event) => {
          event.preventDefault();
          navigate(guidePath("chat"));
        }}
      >
        Open chat
      </a>
    </div>
  );
}

export function GuidePage({ section, sessionId }: { section: string; sessionId?: string }) {
  const api = useMemo(() => createGuideApi(), []);
  const chat = section === "chat";
  const [agent, setAgent] = useState({ name: FALLBACK_NAME, greeting: FALLBACK_GREETING });
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let live = true;
    api.info().then(
      (next) => {
        if (!live) return;
        setAgent({ name: next.name, greeting: next.greeting || FALLBACK_GREETING });
        setOffline(false);
      },
      () => {
        if (live) setOffline(true);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <div className="sf-guide flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--sf-ground)]">
      <PageHeader title="Guide" subtitle="Talk through what to build" />
      {offline ? (
        <p className="m-0 border-b border-[var(--sf-hairline)] px-5 py-2 text-[13px] text-[var(--sf-text-2)]" role="status">
          The console can't reach Stageflow right now. You can look around; sending a message will work once the connection is back.
        </p>
      ) : null}
      {chat ? (
        <GuideRuntime threadId={sessionId}>
          <div className="flex min-h-0 min-w-0 flex-1">
            <GuideSidebar active={section} sessionId={sessionId} />
            <GuideThread agentName={agent.name} greeting={agent.greeting} />
          </div>
        </GuideRuntime>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <GuideSidebar active={section} sessionId={sessionId} />
          <GuideMissing />
        </div>
      )}
    </div>
  );
}
