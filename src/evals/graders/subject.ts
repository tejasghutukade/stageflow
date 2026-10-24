import type { ConversationSubject, EnvelopeSubject, Subject } from "./types.js";

export function isConversation(subject: Subject): subject is ConversationSubject {
  return subject.kind === "conversation";
}

export function subjectEnvelope(subject: EnvelopeSubject): Record<string, unknown> {
  const env: Record<string, unknown> = {
    status: subject.status,
    summary: subject.summary,
    artifacts: subject.artifacts,
  };
  if (subject.payload !== undefined) env.payload = subject.payload;
  return env;
}

export function subjectRoot(subject: Subject): Record<string, unknown> {
  if (isConversation(subject)) {
    const { transcript: _transport, ...root } = subject;
    return root;
  }
  return subjectEnvelope(subject);
}

export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function show(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
