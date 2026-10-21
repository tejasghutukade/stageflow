import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

/** Loaded on demand so the first paint does not wait for the markdown parser. */
export default function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="sf-chat-md" />;
}
