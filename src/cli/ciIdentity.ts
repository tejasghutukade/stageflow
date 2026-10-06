export type CiIdentityFlags = {
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
};

export type CiIdentity = {
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
};

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function prNumberFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  const ref = nonempty(env.GITHUB_REF);
  if (ref !== undefined) {
    const match = /^refs\/pull\/(\d+)\//.exec(ref);
    if (match?.[1] !== undefined) return match[1];
  }
  const refName = nonempty(env.GITHUB_REF_NAME);
  if (refName !== undefined) {
    const match = /^(\d+)\/merge$/.exec(refName);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export function resolveCiIdentity(input: {
  flags: CiIdentityFlags;
  env: Record<string, string | undefined>;
}): CiIdentity {
  const result: CiIdentity = {};

  const gitSha = nonempty(input.flags.gitSha) ?? nonempty(input.env.GITHUB_SHA);
  if (gitSha !== undefined) result.gitSha = gitSha;

  const flagPrUrl = nonempty(input.flags.ciPrUrl);
  if (flagPrUrl !== undefined) {
    result.ciPrUrl = flagPrUrl;
  } else {
    const prNumber = prNumberFromEnv(input.env);
    const server = nonempty(input.env.GITHUB_SERVER_URL);
    const repo = nonempty(input.env.GITHUB_REPOSITORY);
    if (prNumber !== undefined && server !== undefined && repo !== undefined) {
      result.ciPrUrl = `${server}/${repo}/pull/${prNumber}`;
    }
  }

  const flagJobUrl = nonempty(input.flags.ciJobUrl);
  if (flagJobUrl !== undefined) {
    result.ciJobUrl = flagJobUrl;
  } else {
    const server = nonempty(input.env.GITHUB_SERVER_URL);
    const repo = nonempty(input.env.GITHUB_REPOSITORY);
    const runId = nonempty(input.env.GITHUB_RUN_ID);
    if (server !== undefined && repo !== undefined && runId !== undefined) {
      result.ciJobUrl = `${server}/${repo}/actions/runs/${runId}`;
    }
  }

  return result;
}
