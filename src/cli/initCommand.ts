import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findProjectRoot } from "../project/findProjectRoot.js";
import { ensureGlobalHome } from "../project/globalHome.js";
import {
  HELLO_PIPELINE_YAML,
  HELLO_TASK_YAML,
  STAGEFLOW_YAML,
} from "./initTemplates.js";

export const INIT_USAGE = `Usage:
  sf init`;

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

const INIT_TARGETS: InitTarget[] = [
  { relPath: "stageflow.yaml", content: STAGEFLOW_YAML },
  { relPath: "pipelines/hello.pipeline.yaml", content: HELLO_PIPELINE_YAML },
  { relPath: "tasks/hello.task.yaml", content: HELLO_TASK_YAML },
];

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

function parseInitArgs(args: string[]): { help: boolean } {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }
  if (args[0].startsWith("-")) {
    throw new Error(`Unknown flag: ${args[0]}`);
  }
  throw new Error(`Unexpected argument: ${args[0]}`);
}

export async function runInitCommand(
  args: string[],
  options: { cwd?: string; io?: Partial<InitCommandIo> } = {},
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

    for (const target of INIT_TARGETS) {
      const absPath = path.join(initRoot, target.relPath);
      if (await fileExists(absPath)) {
        out.log(`Skipped ${target.relPath} (exists)`);
        continue;
      }
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, target.content, "utf8");
      out.log(`Created ${target.relPath}`);
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
