import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  importTaskFromIssue,
  parseImportTaskBody,
  type IssueFetch,
} from "../config/importTask.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import { catching, projectFields, resolveWriteTarget } from "./writeTarget.js";

type CatalogWriteDeps = McpToolDeps & {
  issueFetch?: IssueFetch;
};

const projectRootField = z
  .string()
  .optional()
  .describe(
    "Catalog project root. When omitted, the Host workspace is used.",
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
    async ({ project_root, ...body }) =>
      catching(async () => {
        const parsed = parseImportTaskBody(body);
        if ("ok" in parsed) return rejected(parsed);
        const target = await resolveWriteTarget(deps, project_root);
        const result = await importTaskFromIssue(target.path, parsed, deps.issueFetch);
        if (!result.ok) return rejected(result);
        return textResult({ task: result.task, ...projectFields(target) });
      }),
  );
}