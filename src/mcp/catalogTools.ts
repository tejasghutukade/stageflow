import path from "node:path";
import { buildModelsResponse } from "../models/response.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  catalogPathErrorBody,
  CatalogPathError,
  resolveCatalogRelativePath,
  resolveCatalogStartInput,
} from "../config/catalogRelativePath.js";
import {
  listPipelinesMultiProject,
  listTasksMultiProject,
} from "../config/multiProjectCatalog.js";
import { readYamlObject } from "../config/readYamlObject.js";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import { PACKAGE_VERSION, BUILD_SHA } from "../package-meta.js";
import { stageflowHomeForDisplay } from "../project/globalHome.js";
import {
  getAuthStatus,
} from "../agent/providerAuth.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import { PipelinePreflightError } from "../runtime/pipelineRunner.js";
import {
  EnvelopeRefError,
  resolveEnvelopeRefsToTask,
} from "../runtime/resolveEnvelopeRef.js";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import { isTerminalProjection, isWaitingProjection, waitRun } from "../runread/waitRun.js";
import { mapStartFailure, mapStoreLookupError } from "../server/operatorResults.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
} from "../server/requestAuthContext.js";
import type { McpToolDeps } from "./deps.js";
import { projectRun } from "../projection/projectRun.js";
import { textResult } from "./toolResults.js";
import { listCatalogFlatSchema, validateFlatSchema } from "../toolkit/catalogToolModes.js";
import {
  envelopeRefField,
  getRunFlatSchema,
  inlinePipelineSchema,
  startRunFlatSchema,
  taskFileSchema,
} from "../toolkit/runToolModes.js";
import {
  inspectProviderReadiness,
  mapProviderAuthError,
} from "../agent/providerInspect.js";
import { listProjectMcpCatalog } from "../config/resolveStageMcpServers.js";
import { runValidateKind } from "./validateMcpKinds.js";
import { buildRunExportPayload } from "../runstore/exportRunPayload.js";
import { redactRunManifestForRead } from "../runstore/runManifest.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runSkillsDir } from "../runtime/runSkills.js";
import { listSkillsWithOrigin } from "../config/listSkills.js";
import {
  findTokenShapedField,
  pickCheckoutOverride,
  tokenRejectedPayload,
} from "../runtime/startPayload.js";
import { toolchainHealthMap } from "../preflight/toolchain.js";

const auditLog = rootLogger.child({ component: "audit" });

const runStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export function registerCatalogTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store, cwd, providerAuthContext, providerBoot } = deps;
  const agentDir = deps.agentDir ?? getAgentDir();

  server.registerTool(
    "list_catalog",
    {
      description:
        "List pipelines, tasks, skills, models, MCP servers, providers, or host health. Pick kind; optional project_root or runId (skills only).",
      inputSchema: listCatalogFlatSchema,
    },
    async (args) => {
      const parsed = listCatalogFlatSchema.safeParse(args);
      if (!parsed.success) {
        return textResult(
          { error: parsed.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      const { kind, project_root, runId } = parsed.data;
      const mcpRoot = deps.projectRoot ?? cwd;
      switch (kind) {
        case "pipelines": {
          const result = await listPipelinesMultiProject({
            store,
            bootCwd: cwd,
            projectRootFilter: project_root,
          });
          if (
            result.root_errors.some((e) => e.code === "unknown_project_root") &&
            result.items.length === 0
          ) {
            return textResult(
              {
                error: result.root_errors[0]!.message,
                code: "unknown_project_root",
                root_errors: result.root_errors,
              },
              true,
            );
          }
          return textResult({
            pipelines: result.items,
            root_errors: result.root_errors,
            ...(result.tip !== undefined ? { tip: result.tip } : {}),
          });
        }
        case "tasks": {
          const result = await listTasksMultiProject({
            store,
            bootCwd: cwd,
            projectRootFilter: project_root,
          });
          if (
            result.root_errors.some((e) => e.code === "unknown_project_root") &&
            result.items.length === 0
          ) {
            return textResult(
              {
                error: result.root_errors[0]!.message,
                code: "unknown_project_root",
                root_errors: result.root_errors,
              },
              true,
            );
          }
          return textResult({
            tasks: result.items,
            root_errors: result.root_errors,
            ...(result.tip !== undefined ? { tip: result.tip } : {}),
          });
        }
        case "skills": {
          try {
            let runSkills: string | undefined;
            let checkoutRoot: string | undefined;
            if (runId !== undefined) {
              const meta = await store.readRunMeta(runId);
              runSkills = runSkillsDir(store.getWorkspaceDir(runId));
              checkoutRoot = meta.checkout_root;
            }
            const catalog = await listSkillsWithOrigin({
              cwd,
              agentDir,
              ...(runSkills !== undefined ? { runSkillsDir: runSkills } : {}),
              ...(checkoutRoot !== undefined ? { checkoutRoot } : {}),
            });
            return textResult({
              skills: catalog.skills,
              diagnostics: catalog.diagnostics,
            });
          } catch (err) {
            if (runId !== undefined) {
              const mapped = mapStoreLookupError(err, { policy: "run" });
              return textResult({ error: mapped.error, status: mapped.status }, true);
            }
            throw err;
          }
        }
        case "models": {
          const { response, used: result } = await buildModelsResponse({
            store,
            cwd,
            projectRootFilter: project_root,
          });
          if (
            result.root_errors.some((e) => e.code === "unknown_project_root") &&
            result.items.length === 0
          ) {
            return textResult(
              {
                error: result.root_errors[0]!.message,
                code: "unknown_project_root",
                root_errors: result.root_errors,
              },
              true,
            );
          }
          return textResult(response);
        }
        case "mcp_servers":
          return textResult(await listProjectMcpCatalog(mcpRoot));
        case "providers":
          try {
            return textResult(await inspectProviderReadiness(cwd, providerAuthContext));
          } catch (err) {
            const mapped = mapProviderAuthError(err);
            return textResult({ error: mapped.body.error, status: mapped.status }, true);
          }
        case "health": {
          const boot_providers = providerBoot
            ? { configured: providerBoot.configured, failures: providerBoot.failures }
            : {
                configured: [] as string[],
                failures: [] as Array<{ providerId: string; code: string; message: string }>,
              };
          let providers_live: { configured: string[]; note: string } = {
            configured: [],
            note: "Live auth inspect — prefer list_catalog with kind providers / sf providers status. boot_providers is Host boot env only and may be empty when CLI credentials are configured.",
          };
          if (providerAuthContext !== undefined) {
            try {
              const status = await getAuthStatus(cwd, undefined, providerAuthContext);
              const rows = Array.isArray(status) ? status : [status];
              providers_live = {
                configured: rows.filter((r) => r.configured).map((r) => r.providerId),
                note: providers_live.note,
              };
            } catch {
              /* keep empty */
            }
          }
          return textResult({
            ...(await manager.getHealthWithDisk()),
            version: PACKAGE_VERSION,
            build_sha: BUILD_SHA,
            toolchain: toolchainHealthMap(),
            stageflow_home: stageflowHomeForDisplay(),
            boot_providers,
            providers_live,
            providers: boot_providers,
          });
        }
        default:
          return textResult({ error: `Unknown kind: ${kind}`, status: 400 }, true);
      }
    },
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start a pipeline run. Accepted params: pipeline (catalog-relative path or inline { id, stages: [...] } — stages are YAML stage bodies, no uses: refs), task_path XOR task (inline task may include repository/ref or checkout; repository XOR checkout with code task.binding_conflict), project_root, checkout (catalog-relative; prefer this name; absolute → absolute_path_not_allowed), checkout_override (alias of checkout), skip_gates, git_sha, ci_pr_url, ci_job_url, skills (name → { relativePath: utf-8 contents }; requires SKILL.md; materialised under runs/<runId>/skills/, never the worktree). Returns { runId } or { runId, queued: true, queuePosition }. Errors: busy_capacity, busy_checkout, insufficient_disk, start.token_rejected, skills_*, inline_pipeline_too_large, catalog path-contract codes.",
      inputSchema: startRunFlatSchema,
    },
    async (args) => {
      const parsedFlat = startRunFlatSchema.safeParse(args);
      if (!parsedFlat.success) {
        return textResult(
          { error: parsedFlat.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      const flat = parsedFlat.data;
      if (flat.from_run !== undefined) {
        const callerId = callerIdFromRequestAuth();
        const result = await manager.rerun(flat.from_run, {
          ...(flat.pinned !== undefined ? { pinned: flat.pinned } : {}),
          callerId,
        });
        if (!result.ok) {
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "rerun",
            target_run_id: flat.from_run,
            outcome: "error",
            ...(result.code !== undefined ? { error_code: result.code } : {}),
          });
          return textResult(
            {
              ...mapStartFailure(result),
              ...(result.status !== undefined ? { status: result.status } : {}),
            },
            true,
          );
        }
        writeAudit(auditLog, {
          caller_id: callerId,
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "rerun",
          target_run_id: result.runId,
          outcome: "ok",
        });
        return textResult({ runId: result.runId });
      }
      if (flat.stage !== undefined) {
        const { stage, project_root, task_path, task, envelope_ref, checkout, model, blocking, timeout_ms } = flat;
        let taskInput: string | z.infer<typeof taskFileSchema> | undefined = task_path ?? task;
        if (envelope_ref) {
          try {
            taskInput = await resolveEnvelopeRefsToTask(store, envelope_ref, checkout);
          } catch (err) {
            if (err instanceof EnvelopeRefError) {
              return textResult({ error: err.message, status: err.status }, true);
            }
            throw err;
          }
        }
        if (taskInput === undefined) {
          return textResult(
            { error: "Exactly one of task_path, task, or envelope_ref is required" },
            true,
          );
        }
        let stageBody: Record<string, unknown>;
        let stageProjectRoot: string | undefined;
        if (typeof stage === "string") {
          if (!stage.trim()) {
            return textResult({ error: "stage is required" }, true);
          }
          let absPath = "";
          try {
            const { wireRoot, roots } = await resolveCatalogStartInput(
              { store: deps.store, bootCwd: deps.cwd },
              project_root,
            );
            stageProjectRoot = wireRoot.path;
            absPath = resolveCatalogRelativePath({
              inputPath: stage,
              projectRoot: wireRoot.project_root,
              roots,
              fieldName: "stage",
            }).absolutePath;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              return textResult(catalogPathErrorBody(err), true);
            }
            throw err;
          }
          try {
            stageBody = await readYamlObject(absPath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return textResult({ error: `Failed to read stage file: ${message}` }, true);
          }
        } else {
          stageBody = stage;
        }
        if (typeof stageBody.id !== "string" || !stageBody.id.trim()) {
          return textResult({ error: "stage.id is required" }, true);
        }
        const stageId = stageBody.id;
        const effectiveStageBody = model !== undefined ? { ...stageBody, model } : stageBody;
        const pipelineDef: InlinePipelineDefinition = {
          id: `standalone-${stageId}`,
          stages: [effectiveStageBody],
        };
        let stageResult;
        try {
          stageResult = await manager.startRun({
            pipeline: pipelineDef,
            task: taskInput,
            ...(stageProjectRoot !== undefined ? { projectRoot: stageProjectRoot } : {}),
          });
        } catch (err) {
          if (err instanceof PipelineValidationError) {
            return textResult({ error: "Stage validation failed", validation: err.result }, true);
          }
          throw err;
        }
        if (!stageResult.ok) {
          const { ok: _ok, reason, ...rest } = stageResult;
          return textResult({ error: reason, ...rest }, true);
        }
        const runId = stageResult.runId;
        if (!blocking) {
          return textResult({ runId, stageId });
        }
        const waited = await waitRun({ store, runId, timeoutMs: timeout_ms, until: "any" });
        if (!waited.ok) {
          return textResult(
            {
              error: waited.error,
              ...(waited.status !== undefined ? { status: waited.status } : {}),
              ...(waited.code !== undefined ? { code: waited.code } : {}),
            },
            true,
          );
        }
        const stageProjection = waited.run.stages.find((s) => s.stage_id === stageId);
        if (isTerminalProjection(waited.run)) {
          return textResult({
            runId,
            stageId,
            status: "completed",
            envelope: stageProjection?.envelope ?? null,
          });
        }
        if (isWaitingProjection(waited.run)) {
          return textResult({
            runId,
            stageId,
            status: "needs_input",
            pending_prompt: stageProjection?.pending_prompt,
            waiting_kind: waited.run.waiting_kind,
            waiting_prompt_id: waited.run.waiting_prompt_id,
            waiting_summary: waited.run.waiting_summary,
          });
        }
        return textResult({ runId, stageId, status: "timeout" });
      }
      const tokenField = findTokenShapedField(flat);
      if (tokenField !== undefined) {
        return textResult(tokenRejectedPayload(tokenField), true);
      }
      const {
        pipeline,
        task_path,
        task,
        project_root,
        checkout,
        checkout_override,
        skip_gates,
        git_sha,
        ci_pr_url,
        ci_job_url,
        skills,
      } = flat;
      if (pipeline === undefined) {
        return textResult({ error: "pipeline is required" }, true);
      }
      if (typeof pipeline === "string" && !pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
      }
      let wireRoot;
      let roots;
      try {
        ({ wireRoot, roots } = await resolveCatalogStartInput(
          { store: deps.store, bootCwd: deps.cwd },
          project_root,
        ));
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(err), true);
        }
        throw err;
      }
      const wireProjectRoot = wireRoot.project_root;
      let resolvedPipeline: typeof pipeline = pipeline;
      let resolvedTask: typeof taskInput = taskInput;
      let resolvedCheckout: string | undefined;
      try {
        if (typeof pipeline === "string") {
          resolvedPipeline = resolveCatalogRelativePath({
            inputPath: pipeline,
            projectRoot: wireProjectRoot,
            roots,
            fieldName: "pipeline",
          }).absolutePath;
        }
        if (typeof task_path === "string") {
          resolvedTask = resolveCatalogRelativePath({
            inputPath: task_path,
            projectRoot: wireProjectRoot,
            roots,
            fieldName: "task_path",
          }).absolutePath;
        }
        const rawCheckout = pickCheckoutOverride({ checkout, checkout_override });
        if (rawCheckout !== undefined) {
          resolvedCheckout = resolveCatalogRelativePath({
            inputPath: rawCheckout,
            projectRoot: wireProjectRoot,
            roots,
            fieldName: "checkout",
          }).absolutePath;
        }
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(err), true);
        }
        throw err;
      }
      const callerId = callerIdFromRequestAuth();
      let result;
      try {
        result = await manager.startRun({
          pipeline: resolvedPipeline,
          task: resolvedTask,
          projectRoot: wireRoot.path,
          ...(resolvedCheckout !== undefined
            ? { checkoutOverride: resolvedCheckout }
            : {}),
          ...(skip_gates !== undefined ? { skipGates: skip_gates } : {}),
          ...(git_sha !== undefined ? { gitSha: git_sha } : {}),
          ...(ci_pr_url !== undefined ? { ciPrUrl: ci_pr_url } : {}),
          ...(ci_job_url !== undefined ? { ciJobUrl: ci_job_url } : {}),
          ...(skills !== undefined ? { skills } : {}),
          callerId,
        });
      } catch (err) {
        if (err instanceof PipelineValidationError) {
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "start_run",
            outcome: "error",
            error_code: "pipeline_validation",
          });
          return textResult(
            { error: "Pipeline validation failed", validation: err.result },
            true,
          );
        }
        if (err instanceof PipelinePreflightError) {
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "start_run",
            outcome: "error",
            error_code: err.code,
          });
          return textResult(err.toNetworkBody(), true);
        }
        throw err;
      }
      if (!result.ok) {
        writeAudit(auditLog, {
          caller_id: callerId,
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "start_run",
          outcome: "error",
          error_code: result.code,
        });
        const { ok: _ok, reason, ...rest } = result;
        return textResult({ error: reason, ...rest }, true);
      }
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "start_run",
        target_run_id: result.runId,
        outcome: "ok",
      });
      return textResult({
        runId: result.runId,
        ...(result.queued === true
          ? {
              queued: true,
              queuePosition: result.queuePosition,
              ...(result.queuedCode !== undefined
                ? { queuedCode: result.queuedCode }
                : {}),
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "get_run",
    {
      description:
        "List runs without runId; poll one run with runId; view: export returns the full export payload. Stage detail lives in get_stage.",
      inputSchema: getRunFlatSchema,
    },
    async ({ runId, view, status, since, pipeline, caller_id }) => {
      if (runId === undefined) {
        const filter: ListRunsFilter = {};
        if (status !== undefined) filter.status = status as RunStatus;
        if (since !== undefined) {
          if (!Number.isFinite(Date.parse(since))) {
            return textResult({ error: "since must be a valid date", status: 400 }, true);
          }
          filter.since = since;
        }
        if (pipeline !== undefined) filter.pipeline = pipeline;
        if (caller_id !== undefined) filter.caller_id = caller_id;
        const runs = await store.listRuns(Object.keys(filter).length > 0 ? filter : undefined);
        return textResult({ runs });
      }
      try {
        const detail = await store.readRun(runId);
        if (view === "export") {
          return textResult(buildRunExportPayload(detail));
        }
        return textResult({
          ...projectRun(detail),
          run_manifest: redactRunManifestForRead(detail.run_manifest),
        });
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult({ error: mapped.error, status: mapped.status }, true);
      }
    },
  );

  server.registerTool(
    "validate",
    {
      description:
        "Validate catalog, pipeline, task, draft package, agent definition, eval, or connection recipient. Use kind and preflight: true for pipeline preflight before start_run.",
      inputSchema: validateFlatSchema,
    },
    async (args) => {
      const parsed = validateFlatSchema.safeParse(args);
      if (!parsed.success) {
        return textResult(
          { error: parsed.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      return runValidateKind(deps, parsed.data);
    },
  );
}
