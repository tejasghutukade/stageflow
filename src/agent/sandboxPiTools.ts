import { Type } from "typebox";
import {
  editSandboxFile,
  readSandboxFile,
  runSandboxBash,
  sliceSandboxLines,
  writeSandboxFile,
  type SandboxFileTarget,
} from "../runtime/sandboxFiles.js";
import {
  resolveHostSearchPath,
  resolveSandboxSearchPath,
  runFind,
  runGrep,
  runHostShell,
  runLs,
  sandboxCommandRunner,
  type FindQuery,
  type GrepQuery,
  type LsQuery,
} from "../runtime/workspaceSearch.js";

export type SandboxPiToolOptions = SandboxFileTarget & {
  readonlyDir?: string;
  missingFileGuidance?: string;
  execute?: Parameters<typeof sandboxCommandRunner>[0]["execute"];
};

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
    description: options.readonlyDir
      ? `Execute a bash command in this stage's sandbox. The working directory is /workspace. One folder is mounted read-only at ${options.readonlyDir}. Read files there. ${options.missingFileGuidance ?? "If a file is missing, stop. Do not create a stand-in."}`
      : "Execute a bash command in this stage's sandbox. The working directory is /workspace. The host filesystem is not mounted.",
    promptSnippet: "Execute bash commands in /workspace",
    promptGuidelines: [
      options.readonlyDir
        ? `The shell starts in /workspace. The only host folder you can read is ${options.readonlyDir}, and it is read-only. ${options.missingFileGuidance ?? "If a file is not there, stop. Do not create stand-in documents."}`
        : "The shell starts in /workspace. Do not use host paths.",
    ],
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

function searchDescription(action: string, readonlyDir?: string): string {
  const mount =
    readonlyDir !== undefined
      ? ` One folder is mounted read-only at ${readonlyDir} and can be searched.`
      : "";
  return `${action} Paths are relative to /workspace or absolute under /workspace.${mount} A host path, a ~ path, and a path that escapes the workspace are rejected.`;
}

function searchPath(options: SandboxPiToolOptions, inputPath: string | undefined): string {
  return resolveSandboxSearchPath(inputPath, options.readonlyDir);
}

function hostRunner(cwd: string) {
  return (command: string) => runHostShell(cwd, command);
}

function workingTreeDescription(action: string): string {
  return `${action} Paths stay inside this stage's working tree. A host path, a ~ path, and a path that escapes the tree are rejected.`;
}

export function createWorkingTreeGrepTool(cwd: string) {
  const run = hostRunner(cwd);
  return {
    name: "grep",
    label: "grep",
    description: workingTreeDescription("Search file contents in this stage's working tree."),
    promptSnippet: "Search file contents inside the stage working tree",
    promptGuidelines: ["Use grep inside the working tree. Host paths are rejected."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex, or a literal string when literal is true)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: the working tree)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Lines to show before and after each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matching lines to return (default: 100)" })),
    }),
    execute: async (_toolCallId: string, params: GrepQuery) => {
      try {
        const text = await runGrep(await resolveHostSearchPath(cwd, params.path), params, run);
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createWorkingTreeFindTool(cwd: string) {
  const run = hostRunner(cwd);
  return {
    name: "find",
    label: "find",
    description: workingTreeDescription("Find files by glob pattern in this stage's working tree."),
    promptSnippet: "Find files inside the stage working tree",
    promptGuidelines: ["Use find inside the working tree. Host paths are rejected."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. '*.ts' or 'src/**/*.spec.ts'" }),
      path: Type.Optional(Type.String({ description: "Directory to search (default: the working tree)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
    }),
    execute: async (_toolCallId: string, params: FindQuery) => {
      try {
        const text = await runFind(await resolveHostSearchPath(cwd, params.path), params, run);
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createWorkingTreeLsTool(cwd: string) {
  const run = hostRunner(cwd);
  return {
    name: "ls",
    label: "ls",
    description: workingTreeDescription("List a directory in this stage's working tree."),
    promptSnippet: "List a directory inside the stage working tree",
    promptGuidelines: ["Use ls inside the working tree. Host paths are rejected."],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: the working tree)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries (default: 500)" })),
    }),
    execute: async (_toolCallId: string, params: LsQuery) => {
      try {
        const text = await runLs(await resolveHostSearchPath(cwd, params.path), params, run);
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createSandboxGrepTool(options: SandboxPiToolOptions) {
  const run = sandboxCommandRunner(options);
  return {
    name: "grep",
    label: "grep",
    description: searchDescription(
      "Search file contents inside this stage's sandbox.",
      options.readonlyDir,
    ),
    promptSnippet: "Search file contents inside /workspace",
    promptGuidelines: [
      "Use grep to search under /workspace. Host paths are rejected.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex, or a literal string when literal is true)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: /workspace)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Lines to show before and after each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return (default: 100)" })),
    }),
    execute: async (_toolCallId: string, params: GrepQuery) => {
      try {
        const text = await runGrep(searchPath(options, params.path), params, run);
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createSandboxFindTool(options: SandboxPiToolOptions) {
  const run = sandboxCommandRunner(options);
  return {
    name: "find",
    label: "find",
    description: searchDescription(
      "Find files by glob pattern inside this stage's sandbox.",
      options.readonlyDir,
    ),
    promptSnippet: "Find files inside /workspace",
    promptGuidelines: ["Use find to locate files under /workspace. Host paths are rejected."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. '*.ts' or 'src/**/*.spec.ts'" }),
      path: Type.Optional(Type.String({ description: "Directory to search (default: /workspace)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
    }),
    execute: async (_toolCallId: string, params: FindQuery) => {
      try {
        const text = await runFind(searchPath(options, params.path), params, run);
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createSandboxLsTool(options: SandboxPiToolOptions) {
  const run = sandboxCommandRunner(options);
  return {
    name: "ls",
    label: "ls",
    description: searchDescription(
      "List a directory inside this stage's sandbox.",
      options.readonlyDir,
    ),
    promptSnippet: "List a directory inside /workspace",
    promptGuidelines: ["Use ls to list directories under /workspace. Host paths are rejected."],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: /workspace)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries (default: 500)" })),
    }),
    execute: async (_toolCallId: string, params: LsQuery) => {
      try {
        const text = await runLs(searchPath(options, params.path), params, run);
        return textResult(text);
      } catch (err) {
        return failure(err);
      }
    },
  };
}
