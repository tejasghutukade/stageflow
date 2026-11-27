import { createContext, useContext, type ReactNode } from "react";

export type ChatSandboxContextValue = {
  sandboxOrigins: string[];
};

const ChatSandboxContext = createContext<ChatSandboxContextValue>({ sandboxOrigins: [] });

export function ChatSandboxProvider({ origins, children }: { origins: string[]; children: ReactNode }) {
  return <ChatSandboxContext.Provider value={{ sandboxOrigins: origins }}>{children}</ChatSandboxContext.Provider>;
}

export function useChatSandboxOrigins(): ChatSandboxContextValue {
  return useContext(ChatSandboxContext);
}