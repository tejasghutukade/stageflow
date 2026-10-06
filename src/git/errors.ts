export type GitErrorCode =
  | "auth_failed"
  | "ref_not_found"
  | "repo_not_found"
  | "network"
  | "disk_full"
  | "git_missing"
  | "timeout"
  | "unknown";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly argv: string[];
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(
    message: string,
    options: {
      code: GitErrorCode;
      argv: string[];
      stderr: string;
      exitCode: number | null;
    },
  ) {
    super(message);
    this.name = "GitError";
    this.code = options.code;
    this.argv = options.argv;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
  }
}

const URL_CREDENTIALS = /:\/\/([^/\s]*?):([^/\s]*?)@/g;
const TOKEN_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgho_[A-Za-z0-9_]{20,}\b/g,
  /\bghu_[A-Za-z0-9_]{20,}\b/g,
  /\bghs_[A-Za-z0-9_]{20,}\b/g,
  /\bghr_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_\-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

const ENV_SECRET_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN_FILE",
  "GH_TOKEN_FILE",
] as const;

export function redactGitText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = text.replace(URL_CREDENTIALS, "://$1:***@");
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, "***");
  }
  for (const key of ENV_SECRET_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length >= 8 && !key.endsWith("_FILE")) {
      out = out.split(value).join("***");
    }
  }
  return out;
}

export function classifyGitFailure(input: {
  stderr: string;
  exitCode: number | null;
  errno?: string | null;
  timedOut?: boolean;
}): GitErrorCode {
  if (input.errno === "ENOENT") return "git_missing";
  if (input.timedOut) return "timeout";

  const stderr = input.stderr;
  const lower = stderr.toLowerCase();

  if (
    /authentication failed/i.test(stderr) ||
    /could not read username/i.test(stderr) ||
    /could not read password/i.test(stderr) ||
    /invalid username or password/i.test(stderr) ||
    /authentication required/i.test(stderr) ||
    /access denied/i.test(stderr) ||
    /terminal prompts disabled/i.test(stderr)
  ) {
    return "auth_failed";
  }

  // GitHub hides private repos behind "not found"; treat as auth-suspicion.
  if (
    /remote:\s*repository not found/i.test(stderr) ||
    (/repository ['`].*['`] not found/i.test(stderr) && /github\.com/i.test(stderr))
  ) {
    return "auth_failed";
  }

  if (
    /couldn't find remote ref/i.test(stderr) ||
    /unknown revision/i.test(stderr) ||
    /bad revision/i.test(stderr) ||
    /invalid refspec/i.test(stderr) ||
    /needed a single revision/i.test(stderr) ||
    /not a valid object name/i.test(stderr) ||
    /ambiguous argument .* unknown revision/i.test(stderr)
  ) {
    return "ref_not_found";
  }

  if (
    /does not appear to be a git repository/i.test(stderr) ||
    /not a git repository/i.test(stderr) ||
    /repository .* does not exist/i.test(stderr) ||
    (/fatal: repository ['`].*['`] not found/i.test(stderr) && !/github\.com/i.test(stderr))
  ) {
    return "repo_not_found";
  }

  if (
    /could not resolve host/i.test(stderr) ||
    /failed to connect/i.test(stderr) ||
    /connection refused/i.test(stderr) ||
    /network is unreachable/i.test(stderr) ||
    /timed out/i.test(lower) ||
    /unable to access/i.test(stderr)
  ) {
    return "network";
  }

  if (/no space left on device/i.test(stderr) || /disk quota exceeded/i.test(stderr)) {
    return "disk_full";
  }

  return "unknown";
}
