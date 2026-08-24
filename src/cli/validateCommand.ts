import {
  validateCatalog as defaultValidateCatalog,
  type ValidationResult,
} from "../config/validateCatalog.js";
import {
  exitCodeForValidation,
  formatValidationHuman,
  formatValidationJson,
} from "./validateOutput.js";

export const VALIDATE_USAGE = `Usage:
  sf validate [--pipeline <name-or-path>] [--strict] [--json]`;

export type ValidateCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ValidateCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedValidateArgs = {
  help: boolean;
  pipeline?: string;
  strict: boolean;
  json: boolean;
};

function parseValidateArgs(args: string[]): ParsedValidateArgs {
  if (args.length === 0) {
    return { help: false, strict: false, json: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, strict: false, json: false };
  }

  let pipeline: string | undefined;
  let strict = false;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pipeline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --pipeline");
      }
      pipeline = value;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, pipeline, strict, json };
}

export async function runValidateCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<ValidateCommandIo>;
    validateCatalog?: (
      options: Parameters<typeof defaultValidateCatalog>[0],
    ) => Promise<ValidationResult>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: ValidateCommandIo = { ...defaultIo, ...options.io };
  const validateCatalogFn = options.validateCatalog ?? defaultValidateCatalog;

  try {
    const parsed = parseValidateArgs(args);
    if (parsed.help) {
      out.error(VALIDATE_USAGE);
      return 0;
    }

    const result = await validateCatalogFn({
      scope: parsed.pipeline ? "pipeline" : "full",
      cwd,
      pipeline: parsed.pipeline,
      strict: parsed.strict,
    });

    if (parsed.json) {
      out.log(formatValidationJson(result));
    } else {
      out.log(formatValidationHuman(result, { strict: parsed.strict }));
    }

    return exitCodeForValidation(result);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Validate command failed";
    out.error(message);
    out.error(VALIDATE_USAGE);
    return 1;
  }
}
