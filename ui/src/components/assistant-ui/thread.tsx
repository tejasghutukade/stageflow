import "@assistant-ui/styles/index.css";

import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  type ComponentType,
  type FC,
} from "react";
import { MarkdownText } from "./markdown-text";

export type ThreadToolUIs = {
  by_name?: Record<string, ToolCallMessagePartComponent | undefined>;
  Fallback?: ToolCallMessagePartComponent | undefined;
};

export type ThreadProps = {
  tools?: ThreadToolUIs;
  Welcome?: ComponentType;
  placeholder?: string;
};

const ThreadToolsContext = createContext<ThreadToolUIs | undefined>(undefined);

const SendIcon: FC = () => (
  <svg
    className="aui-composer-send-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M12 19V5M12 5l-6 6M12 5l6 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CopyIcon: FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect
      x="9"
      y="9"
      width="11"
      height="11"
      rx="2"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M5 15V5a2 2 0 0 1 2-2h10"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const ArrowDownIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 5v14M12 19l-6-6M12 19l6-6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function DefaultWelcome() {
  return (
    <div className="aui-thread-welcome-root">
      <div className="aui-thread-welcome-center">
        <div className="aui-thread-welcome-message">
          <p className="aui-thread-welcome-message-inner">What are we building?</p>
        </div>
      </div>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root"
      data-role="user"
      data-slot="aui_user-message-root"
    >
      <div
        className="aui-user-message-content-wrapper"
        data-slot="aui_user-message-content-wrapper"
      >
        <div className="aui-user-message-content" data-slot="aui_user-message-content">
          <MessagePrimitive.Parts />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root">
        <ErrorPrimitive.Message className="aui-message-error-message" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root"
    >
      <ActionBarPrimitive.Copy className="aui-button-icon" aria-label="Copy">
        <CopyIcon />
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function AssistantMessage() {
  const tools = useContext(ThreadToolsContext);
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root"
      data-role="assistant"
      data-slot="aui_assistant-message-root"
    >
      <div
        className="aui-assistant-message-content"
        data-slot="aui_assistant-message-content"
      >
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            tools,
          }}
        />
        <MessageError />
      </div>
      <div
        className="aui-assistant-message-footer"
        data-slot="aui_assistant-message-footer"
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer({ placeholder }: { placeholder: string }) {
  return (
    <ComposerPrimitive.Root className="aui-composer-root">
      <div
        className="aui-composer-attachment-dropzone"
        data-slot="aui_composer-shell"
      >
        <ComposerPrimitive.Input
          className="aui-composer-input"
          placeholder={placeholder}
          rows={1}
          submitMode="enter"
          aria-label="Message input"
        />
        <div className="aui-composer-action-wrapper">
          <div />
          <ComposerPrimitive.Send
            className="aui-composer-send"
            aria-label="Send message"
          >
            <SendIcon />
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

const MESSAGE_COMPONENTS = {
  UserMessage,
  AssistantMessage,
};

/**
 * Stock-style Thread island for Workshop.
 * Cancel is intentionally omitted (KTD6) — ComposerPrimitive.Cancel is not rendered.
 */
export function Thread({
  tools,
  Welcome = DefaultWelcome,
  placeholder = "Describe a stage or workflow change…",
}: ThreadProps) {
  return (
    <ThreadToolsContext.Provider value={tools}>
      <ThreadPrimitive.Root
        className="aui-thread-root"
        style={{
          ["--thread-max-width" as string]: "44rem",
        }}
      >
        <ThreadPrimitive.Viewport
          className="aui-thread-viewport"
          data-slot="aui_thread-viewport"
        >
          <ThreadPrimitive.Empty>
            <Welcome />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer">
            <ThreadPrimitive.ScrollToBottom
              className="aui-thread-scroll-to-bottom"
              aria-label="Scroll to bottom"
            >
              <ArrowDownIcon />
            </ThreadPrimitive.ScrollToBottom>
            <Composer placeholder={placeholder} />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ThreadToolsContext.Provider>
  );
}
