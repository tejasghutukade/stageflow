import path from "node:path";
import {
  applyMigrateYamlPlan,
  fileDirtyVsHead,
  planMigrateYaml,
  type MigrateYamlPlan,
} from "../config/migrateYaml.js";

export const MIGRATE_YAML_USAGE = `Usage:
  sf migrate-yaml [path] [--root <path>] [--write] [--json] [--force]

  Convert legacy catalog YAML to target YAML (io / verify / on_verify_fail).
  Dry-run is the default. --write applies changes. Path may be a pipeline,
  stage, task, or catalog root. Does not rewrite .stageflow snapshots.`;

export type MigrateYamlCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: MigrateYamlCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedMigrateYamlArgs = {
  help: boolean;
  target?: string;
  write: boolean;
  json: boolean;
  force: boolean;
};

function parseMigrateYamlArgs(args: string[]): ParsedMigrateYamlArgs {
  if (args.length === 0) {
    return { help: false, write: false, json: false, force: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, write: false, json: false, force: false };
  }

  let target: string | undefined;
  let root: string | undefined;
  let write = false;
  let json = false;
  let force = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--root") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --root");
      }
      root = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (target !== undefined) {
      throw new Error(`Unexpected argument: ${arg}`);
    } else {
      target = arg;
    }
  }

  if (target !== undefined && root !== undefined) {
    throw new Error("Use at most one of a positional path or --root");
  }

  return { help, target: target ?? root, write, json, force };
}

export type MigrateYamlJson = {
  ok: boolean;
  write: boolean;
  planned: string[];
  written: string[];
  skipped: string[];
  errors: string[];
};

function planToJson(
  plan: MigrateYamlPlan,
  options: { write: boolean; written: string[]; ok: boolean; extraErrors?: string[] },
): MigrateYamlJson {
  return {
    ok: options.ok,
    write: options.write,
    planned: plan.writes.map((item) => item.file),
    written: options.written,
    skipped: plan.skipped,
    errors: [...plan.errors, ...(options.extraErrors ?? [])],
  };
}

function formatHuman(plan: MigrateYamlPlan, write: boolean, extraErrors: string[]): string {
  const lines: string[] = [];
  const errors = [...plan.errors, ...extraErrors];
  if (errors.length > 0) {
    lines.push("Migration failed:");
    for (const error of errors) lines.push(`  ${error}`);
    return lines.join("\n");
  }
  if (write) {
    if (plan.writes.length === 0) {
      lines.push("Nothing to write.");
    } else {
      lines.push("Wrote:");
      for (const item of plan.writes) lines.push(`  ${item.file}`);
    }
  } else if (plan.writes.length === 0) {
    lines.push("Nothing to migrate.");
  } else {
    lines.push("Would write:");
    for (const item of plan.writes) lines.push(`  ${item.file}`);
    lines.push("");
    lines.push("Dry-run; pass --write to apply.");
  }
  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const file of plan.skipped) lines.push(`  ${file}`);
  }
  return lines.join("\n");
}

export async function runMigrateYamlCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<MigrateYamlCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: MigrateYamlCommandIo = { ...defaultIo, ...options.io };

  try {
    const parsed = parseMigrateYamlArgs(args);
    if (parsed.help) {
      out.error(MIGRATE_YAML_USAGE);
      return 0;
    }

    const target = path.resolve(cwd, parsed.target ?? ".");
    const plan = await planMigrateYaml(target, { cwd, projectRoot });
    const extraErrors: string[] = [];

    if (plan.errors.length > 0) {
      if (parsed.json) {
        out.log(JSON.stringify(planToJson(plan, { write: parsed.write, written: [], ok: false }), null, 2));
      } else {
        out.error(formatHuman(plan, parsed.write, extraErrors));
        out.error(MIGRATE_YAML_USAGE);
      }
      return 1;
    }

    if (parsed.write && !parsed.force) {
      for (const item of plan.writes) {
        if (fileDirtyVsHead(item.absPath)) {
          extraErrors.push(
            `Refusing to overwrite uncommitted changes in ${item.file} (pass --force)`,
          );
        }
      }
      if (extraErrors.length > 0) {
        if (parsed.json) {
          out.log(
            JSON.stringify(
              planToJson(plan, {
                write: true,
                written: [],
                ok: false,
                extraErrors,
              }),
              null,
              2,
            ),
          );
        } else {
          out.error(formatHuman(plan, parsed.write, extraErrors));
        }
        return 1;
      }
    }

    let written: string[] = [];
    if (parsed.write) {
      await applyMigrateYamlPlan(plan);
      written = plan.writes.map((item) => item.file);
    }

    if (parsed.json) {
      out.log(
        JSON.stringify(
          planToJson(plan, {
            write: parsed.write,
            written,
            ok: true,
          }),
          null,
          2,
        ),
      );
    } else {
      out.log(formatHuman(plan, parsed.write, extraErrors));
    }
    return 0;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Migrate-yaml command failed";
    out.error(message);
    out.error(MIGRATE_YAML_USAGE);
    return 1;
  }
}
