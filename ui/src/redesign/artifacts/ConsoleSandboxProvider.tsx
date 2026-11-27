import { useMemo, type ReactNode } from "react";
import { ChatSandboxProvider } from "../../chat/sandboxContext";
import { useSandboxOrigin } from "./sandboxOrigin";

/** Gives chat cards in the console (agent sessions, guide) the console's own sandbox origin, as the public chat page gets it from its API. */
export function ConsoleSandboxProvider({ children }: { children: ReactNode }) {
  const { origin } = useSandboxOrigin();
  const origins = useMemo(() => (origin ? [origin] : []), [origin]);
  return <ChatSandboxProvider origins={origins}>{children}</ChatSandboxProvider>;
}
