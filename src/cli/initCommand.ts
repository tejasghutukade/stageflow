import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAuthStatus } from "../agent/providerAuth.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import { ensureGlobalHome } from "../project/globalHome.js";
import {
  HELLO_TASK_YAML,
  STAGEFLOW_YAML,
  helloPipelineYaml,
  isModelPlaceholder,
  resolveInitDefaultModel,
} from "./initTemplates.js";

export const INIT_USAGE = `Usage:
  sf init [--fix-model]

Scaffold stageflow.yaml, pipelines/hello.pipeline.yaml, and tasks/hello.task.yaml.
--fix-model rewrites the hello pipeline model from configured providers when it still contains CHANGE_ME.`;

export type InitCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: InitCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type InitTarget = {
  relPath: string;
  content: string;
};

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

function parseInitArgs(args: string[]): { help: boolean; fixModel: boolean } {
  let help = false;
  let fixModel = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--fix-model") fixModel = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { help, fixModel };
}

async function defaultConfiguredProviderIds(cwd: string): Promise<string[]> {
  try {
    const status = await getAuthStatus(cwd);
    const rows = Array.isArray(status) ? status : [status];
    return rows.filter((r) => r.configured).map((r) => r.providerId);
  } catch {
    return [];
  }
}

export async function runInitCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<InitCommandIo>;
    resolveConfiguredProviderIds?: (cwd: string) => Promise<string[]>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: InitCommandIo = { ...defaultIo, ...options.io };

  try {
    const parsed = parseInitArgs(args);
    if (parsed.help) {
      out.error(INIT_USAGE);
      return 0;
    }

    const initRoot = findProjectRoot(cwd) ?? path.resolve(cwd);
    ensureGlobalHome();

    const configuredIds = await (
      options.resolveConfiguredProviderIds ?? defaultConfiguredProviderIds
    )(cwd);
    const model = resolveInitDefaultModel(configuredIds);

    const helloRel = "pipelines/hello.pipeline.yaml";
    const helloAbs = path.join(initRoot, helloRel);
    if (parsed.fixModel && (await fileExists(helloAbs))) {
      const text = await readFile(helloAbs, "utf8");
      const modelMatch = text.match(/^(\s*)model:\s*["']?([^"'\n]+)["']?/m);
      const current = modelMatch?.[2]?.trim();
      if (current !== undefined && isModelPlaceholder(current)) {
        const next = resolveInitDefaultModel(configuredIds);
        if (!isModelPlaceholder(next)) {
          const indent = modelMatch?.[1] ?? "    ";
          const updated = text.replace(
            /^(\s*)model:\s*["']?[^"'\n]+["']?/m,
            `${indent}model: "${next}"`,
          );
          await writeFile(helloAbs, updated, "utf8");
          out.log(`Updated ${helloRel} model to ${next}`);
        } else {
          out.error(
            `No single configured provider; connect one with sf providers login <id>, then run sf init --fix-model again.`,
          );
          return 1;
        }
      } else {
        out.log(`Skipped ${helloRel} model update (no CHANGE_ME placeholder)`);
      }
    }

    const targets: InitTarget[] = [
      { relPath: "stageflow.yaml", content: STAGEFLOW_YAML },
      {
        relPath: "pipelines/hello.pipeline.yaml",
        content: helloPipelineYaml(model),
      },
      { relPath: "tasks/hello.task.yaml", content: HELLO_TASK_YAML },
    ];

    let createdHelloWithPlaceholder = false;
    for (const target of targets) {
      const absPath = path.join(initRoot, target.relPath);
      if (await fileExists(absPath)) {
        out.log(`Skipped ${target.relPath} (exists)`);
        continue;
      }
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, target.content, "utf8");
      out.log(`Created ${target.relPath}`);
      if (target.relPath === helloRel && isModelPlaceholder(model)) {
        createdHelloWithPlaceholder = true;
      }
    }

    if (createdHelloWithPlaceholder) {
      out.log(
        "No provider connected yet — hello pipeline model is CHANGE_ME. Run `sf providers login <id>`, then `sf init --fix-model` or `sf ready`.",
      );
    }

    return 0;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Init command failed";
    out.error(message);
    out.error(INIT_USAGE);
    return 1;
  }
}
