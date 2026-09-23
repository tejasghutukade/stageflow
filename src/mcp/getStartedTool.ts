import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PACKAGE_VERSION } from "../package-meta.js";
import { listPipelinesMultiProject, listTasksMultiProject } from "../config/multiProjectCatalog.js";
import { resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

export function registerGetStartedTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "get_started",
    {
      description:
        "First-run orientation for remote harnesses: host version, providers, toolchain hints, catalog roots with counts, and a three-call next_steps list. No arguments.",
      inputSchema: z.object({}),
    },
    async () => {
      const roots = await resolveCatalogRoots({
        store: deps.store,
        bootCwd: deps.cwd,
      });
      const pipelines = await listPipelinesMultiProject({
        store: deps.store,
        bootCwd: deps.cwd,
      });
      const tasks = await listTasksMultiProject({
        store: deps.store,
        bootCwd: deps.cwd,
      });
      const catalog_roots = roots.map((root) => ({
        project_root: root.project_root,
        kind: root.kind,
        read_only: root.read_only,
        pipeline_count: pipelines.items.filter(
          (p) => p.project_root === root.project_root,
        ).length,
        task_count: tasks.items.filter((t) => t.project_root === root.project_root)
          .length,
      }));
      const firstRoot =
        catalog_roots.find((r) => r.kind === "seeded") ?? catalog_roots[0];
      const samplePipeline = pipelines.items.find(
        (p) => p.project_root === firstRoot?.project_root,
      );
      const sampleTask = tasks.items.find(
        (t) => t.project_root === firstRoot?.project_root,
      );
      return textResult({
        host: { version: PACKAGE_VERSION },
        providers: deps.providerAuthContext
          ? { note: "Use list_providers for status" }
          : { configured: [] },
        toolchain: { node: process.version },
        catalog_roots,
        next_steps: [
          {
            tool: "list_pipelines",
            args: firstRoot ? { project_root: firstRoot.project_root } : {},
          },
          {
            tool: "list_tasks",
            args: firstRoot ? { project_root: firstRoot.project_root } : {},
          },
          {
            tool: "start_run",
            args: {
              ...(firstRoot ? { project_root: firstRoot.project_root } : {}),
              pipeline: samplePipeline?.path ?? "pipelines/demo.pipeline.yaml",
              task_path: sampleTask?.path ?? "tasks/demo.task.yaml",
            },
          },
        ],
      });
    },
  );
}
