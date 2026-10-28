export const GITHUB_TRIGGER_ACTIONS = [
  "opened",
  "synchronize",
  "updated",
  "merged",
  "closed",
] as const;

export type GithubTriggerAction = (typeof GITHUB_TRIGGER_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(GITHUB_TRIGGER_ACTIONS);

export function isGithubTriggerAction(value: unknown): value is GithubTriggerAction {
  return typeof value === "string" && ACTION_SET.has(value);
}

/**
 * For `event.source` values starting with `github.`, `match.action` must be set
 * to one of the five PR poll actions. Returns an error message or undefined.
 */
export function githubMatchActionError(
  source: string,
  match: Record<string, unknown> | undefined,
): string | undefined {
  if (!source.startsWith("github.")) return undefined;
  const action = match?.action;
  if (action === undefined) {
    return (
      "event.match.action is required for github.* sources " +
      `(one of: ${GITHUB_TRIGGER_ACTIONS.join(", ")})`
    );
  }
  if (!isGithubTriggerAction(action)) {
    return (
      `event.match.action must be one of: ${GITHUB_TRIGGER_ACTIONS.join(", ")} ` +
      `(got ${JSON.stringify(action)})`
    );
  }
  return undefined;
}
