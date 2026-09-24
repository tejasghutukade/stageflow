import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GitError } from "./errors.js";
import { ensureGlobalHome, globalStageflowHome } from "../project/globalHome.js";

const ASKPASS_BASENAME = "git-askpass";

const ASKPASS_SCRIPT = `#!/bin/sh
prompt=\${1-}
case "\$prompt" in
  *Username*|*username*)
    printf '%s\\n' 'x-access-token'
    ;;
  *)
    token=\${GITHUB_TOKEN-}
    if [ -z "\$token" ]; then
      token=\${GH_TOKEN-}
    fi
    if [ -z "\$token" ] && [ -n "\${GITHUB_TOKEN_FILE-}" ] && [ -f "\$GITHUB_TOKEN_FILE" ]; then
      token=\$(cat "\$GITHUB_TOKEN_FILE")
    fi
    if [ -z "\$token" ] && [ -n "\${GH_TOKEN_FILE-}" ] && [ -f "\$GH_TOKEN_FILE" ]; then
      token=\$(cat "\$GH_TOKEN_FILE")
    fi
    printf '%s\\n' "\$token"
    ;;
esac
`;

export function readHostGithubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  for (const key of ["GITHUB_TOKEN_FILE", "GH_TOKEN_FILE"] as const) {
    const file = env[key]?.trim();
    if (!file) continue;
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch {
      // ignore unreadable files; fall through
    }
  }
  return undefined;
}

export function askpassHelperPath(home: string = globalStageflowHome()): string {
  return path.join(home, ASKPASS_BASENAME);
}

export function ensureAskpassHelper(home?: string): string {
  const resolvedHome = home ?? ensureGlobalHome();
  mkdirSync(resolvedHome, { recursive: true });
  const askpass = askpassHelperPath(resolvedHome);
  if (!existsSync(askpass)) {
    writeFileSync(askpass, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
  }
  try {
    chmodSync(askpass, 0o700);
  } catch {
    // best-effort on non-POSIX
  }
  return askpass;
}

export type HostGitAskpassEnvOptions = {
  env?: NodeJS.ProcessEnv;
  requireToken?: boolean;
  home?: string;
};

export function hostGitAskpassEnv(options: HostGitAskpassEnvOptions = {}): NodeJS.ProcessEnv {
  const sourceEnv = options.env ?? process.env;
  const home = options.home ?? ensureGlobalHome();
  const askpass = ensureAskpassHelper(home);
  const token = readHostGithubToken(sourceEnv);
  const requireToken = options.requireToken !== false;

  if (requireToken && !token) {
    throw new GitError("git authentication failed", {
      code: "auth_failed",
      argv: [],
      stderr:
        "GITHUB_TOKEN (or GH_TOKEN / GITHUB_TOKEN_FILE / GH_TOKEN_FILE) is required for repository binding (clone/fetch and later push/PR). Set it on the Host process environment before start.",
      exitCode: null,
    });
  }

  const out: NodeJS.ProcessEnv = {
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
  };

  if (token) {
    out.GITHUB_TOKEN = token;
  }

  return out;
}
