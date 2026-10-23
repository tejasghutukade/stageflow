import { Type } from "typebox";
import {
  editSandboxFile,
  readSandboxFile,
  runSandboxBash,
  sliceSandboxLines,
  writeSandboxFile,
  type SandboxFileTarget,
} from "../runtime/sandboxFiles.js";

export type SandboxPiToolOptions = SandboxFileTarget;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return textResult(message, true);
}

export function createSandboxReadTool(options: SandboxPiToolOptions) {
  return {
    name: "read",
    label: "read",
    description:
      "Read a file inside this stage's sandbox. Paths are relative to /workspace (artifacts/, checkout/, grants/, work/) or absolute under /workspace. Host paths are rejected.",
    promptSnippet: "Read file contents inside /workspace",
    promptGuidelines: [
      "Use read to examine files under /workspace instead of cat or sed.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read, relative to /workspace or absolute under /workspace" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    execute: async (
      _toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
    ) => {
      try {
        const text = await readSandboxFile(options, params.path);
        return textResult(sliceSandboxLines(text, params.offset, params.limit));
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createSandboxWriteTool(options: SandboxPiToolOptions) {
  return {
    name: "write",
    label: "write",
    description:
      "Write a file inside this stage's sandbox. Paths are relative to /workspace or absolute under /workspace. Parent directories are created. Host paths are rejected.",
    promptSnippet: "Create or overwrite files inside /workspace",
    promptGuidelines: ["Use write only for new files or complete rewrites under /workspace."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write, relative to /workspace or absolute under /workspace" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    execute: async (_toolCallId: string, params: { path: string; content: string }) => {
      try {
        await writeSandboxFile(options, params.path, params.content);
        return textResult(`Successfully wrote to ${params.path}`);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createSandboxEditTool(options: SandboxPiToolOptions) {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a file inside this stage's sandbox with exact text replacement. Paths are relative to /workspace or absolute under /workspace. Each oldText must match exactly once in the original file.",
    promptSnippet: "Make precise file edits inside /workspace",
    promptGuidelines: [
      "Use edit for precise changes under /workspace (edits[].oldText must match exactly once).",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit, relative to /workspace or absolute under /workspace" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace. It must be unique in the original file." }),
          newText: Type.String({ description: "Replacement text." }),
        }),
        { description: "One or more targeted replacements against the original file." },
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { path: string; edits: Array<{ oldText: string; newText: string }> },
    ) => {
      try {
        await editSandboxFile(options, params.path, params.edits);
        return textResult(`Successfully edited ${params.path}`);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createSandboxBashTool(options: SandboxPiToolOptions) {
  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in this stage's sandbox. The working directory is /workspace. The host filesystem is not mounted.",
    promptSnippet: "Execute bash commands in /workspace",
    promptGuidelines: ["The shell starts in /workspace. Do not use host paths."],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    execute: async (
      _toolCallId: string,
      params: { command: string; timeout?: number },
    ) => {
      try {
        const text = await runSandboxBash(
          options,
          params.command,
          params.timeout !== undefined ? params.timeout * 1000 : undefined,
        );
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}
