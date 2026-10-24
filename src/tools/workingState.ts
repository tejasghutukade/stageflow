import type {
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  WORKING_STATE_CUSTOM_TYPE,
  WORKING_STATE_KINDS,
  WORKING_STATE_MAX_KEY,
  WORKING_STATE_MAX_VALUE,
  WorkingStateStore,
  workingStateEventsFromEntries,
  type WorkingStateEvent,
} from "../compaction/workingState.js";
import { WORKING_STATE_TOOL_NAME } from "../compaction/types.js";

export type WorkingStateToolOptions = {
  store: WorkingStateStore;
  persist: (event: WorkingStateEvent) => void;
  now?: () => string;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
};

function result(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: { isError },
    ...(isError ? { isError: true } : {}),
  };
}

export function createWorkingStateTool(options: WorkingStateToolOptions) {
  const { store, persist } = options;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    name: WORKING_STATE_TOOL_NAME,
    label: "Working state",
    description:
      "Keep your own structured working state. Older messages and tool results are trimmed automatically, but this state is kept and shown to you again after every trim. Use `set` as soon as you know something you will need later: exact values and identifiers (fact), choices and reasons (decision), what is finished (progress), what remains (todo), what is stuck (blocker). Keep entries short (one or two lines). Reuse a key to update an entry instead of adding a duplicate; use `delete` when an entry no longer matters; `list` shows everything. Never store secrets.",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("set"),
        Type.Literal("delete"),
        Type.Literal("list"),
      ]),
      key: Type.Optional(Type.String({ maxLength: WORKING_STATE_MAX_KEY })),
      kind: Type.Optional(
        Type.Union(WORKING_STATE_KINDS.map((k) => Type.Literal(k)) as [
          ReturnType<typeof Type.Literal>,
          ReturnType<typeof Type.Literal>,
          ...ReturnType<typeof Type.Literal>[],
        ]),
      ),
      value: Type.Optional(Type.String({ maxLength: WORKING_STATE_MAX_VALUE })),
    }),
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      const params = (input ?? {}) as {
        operation?: string;
        key?: string;
        kind?: string;
        value?: string;
      };
      if (params.operation === "list") {
        const rendered = store.render();
        return result(rendered === "" ? "Working state is empty." : rendered);
      }
      if (params.operation === "delete") {
        if (typeof params.key !== "string" || params.key.trim() === "") {
          return result("delete requires key", true);
        }
        if (!store.delete(params.key)) {
          return result(`No entry "${params.key}".`, true);
        }
        persist({ op: "delete", key: params.key.trim(), at: now() });
        return result(`Deleted ${params.key.trim()}.`);
      }
      if (params.operation === "set") {
        const at = now();
        const outcome = store.set({
          key: params.key ?? "",
          kind: params.kind as never,
          value: params.value ?? "",
          updatedAt: at,
        });
        if (!outcome.ok) return result(outcome.error, true);
        persist({
          op: "set",
          key: outcome.entry.key,
          kind: outcome.entry.kind,
          value: outcome.entry.value,
          at,
        });
        const dropped =
          outcome.dropped.length > 0
            ? ` State was full; dropped oldest progress: ${outcome.dropped.join(", ")}.`
            : "";
        return result(
          `${outcome.replaced ? "Updated" : "Saved"} ${outcome.entry.key} (${store.size} entries).${dropped}`,
        );
      }
      return result("operation must be set, delete or list", true);
    },
  };
}

/**
 * Inline Pi extension: registers the tool, persists each change as a custom
 * session entry and rebuilds the store from the session file on first use,
 * so state survives process restarts and resume.
 */
export function createWorkingStateExtension(): ExtensionFactory {
  return (pi) => {
    const store = new WorkingStateStore();
    let restored = false;
    const tool = createWorkingStateTool({
      store,
      persist: (event) => pi.appendEntry(WORKING_STATE_CUSTOM_TYPE, event),
    });
    pi.registerTool({
      ...tool,
      async execute(toolCallId: string, params: unknown,
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        if (!restored) {
          restored = true;
          store.load(workingStateEventsFromEntries(ctx.sessionManager.getEntries()));
        }
        return tool.execute(toolCallId, params);
      },
    } as never);
  };
}
