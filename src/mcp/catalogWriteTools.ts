import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  importTaskFromIssue,
  parseImportTaskBody,
  type IssueFetch,
} from "../config/importTask.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

type CatalogWriteDeps = McpToolDeps & {
  issueFetch?: IssueFetch;
};

const projectRootField = z
  .string()
  .optional()
  .describe(
    "Catalog project root. When omitted, the server project root is used, then the process cwd.",
  );

function rejected(result: {
  error: string;
  status: number;
  code?: string;
}) {
  return textResult(
    {
      error: result.error,
      status: result.status,
      ...(result.code !== undefined ? { code: result.code } : {}),
    },
    true,
  );
}

async function projectRootOf(
  deps: CatalogWriteDeps,
  projectRoot: string | undefined,
): Promise<string> {
  const resolved = path.resolve(projectRoot ?? deps.projectRoot ?? deps.cwd);
  return realpath(resolved).catch(() => resolved);
}

export function registerCatalogWriteTools(server: McpServer, deps: CatalogWriteDeps): void {
  server.registerTool(
    "import_task",
    {
      description:
        "Import a GitHub issue as a standalone catalog task file.",
      inputSchema: z.object({
        project_root: projectRootField,
        repo: z.string().describe("GitHub owner/repo"),
        number: z.number().describe("Positive GitHub issue number"),
        directory: z.string().describe("Directory relative to the project root, e.g. tasks"),
      }),
    },
    async ({ project_root, ...body }) => {
      const parsed = parseImportTaskBody(body);
      if ("ok" in parsed) return rejected(parsed);
      const result = await importTaskFromIssue(
        await projectRootOf(deps, project_root),
        parsed,
        deps.issueFetch,
      );
      if (!result.ok) return rejected(result);
      return textResult({ task: result.task });
    },
  );
}