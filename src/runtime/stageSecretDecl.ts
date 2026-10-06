import { loadFailure, loadSuccess, type LoadOutcome } from "../config/loadOutcome.js";
import { isForeverDeniedSecret } from "./stageEnvironment.js";

export type StageSecretAs = "env" | "helper" | "file";

export type StageSecretDecl = {
  name: string;
  /** Default: helper for git/gh token names, else env for env-kind registry entries / file for file-kind. */
  as?: "env";
};

const GIT_HELPER_DEFAULT_NAMES = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

export function defaultSecretDelivery(
  name: string,
): "helper" | "env" {
  return GIT_HELPER_DEFAULT_NAMES.has(name) ? "helper" : "env";
}

export function parseStageSecrets(
  raw: unknown,
  label: string,
  stageId?: string,
): LoadOutcome<StageSecretDecl[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw)) {
    return loadFailure([
      {
        code: "stage.invalid_secrets",
        message: `Invalid stage ${label}: secrets must be an array`,
        category: "stage",
        stageId,
      },
    ]);
  }
  const decls: StageSecretDecl[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let name: string;
    let asEnv = false;
    if (typeof item === "string") {
      name = item.trim();
    } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== "string" || obj.name.trim() === "") {
        return loadFailure([
          {
            code: "stage.invalid_secrets",
            message: `Invalid stage ${label}: secrets entries must be strings or { name, as? }`,
            category: "stage",
            stageId,
          },
        ]);
      }
      name = obj.name.trim();
      if (obj.as !== undefined) {
        if (obj.as !== "env") {
          return loadFailure([
            {
              code: "stage.invalid_secrets",
              message: `Invalid stage ${label}: secrets as must be "env" when set`,
              category: "stage",
              stageId,
            },
          ]);
        }
        asEnv = true;
      }
    } else {
      return loadFailure([
        {
          code: "stage.invalid_secrets",
          message: `Invalid stage ${label}: secrets entries must be strings or { name, as? }`,
          category: "stage",
          stageId,
        },
      ]);
    }
    if (name === "") {
      return loadFailure([
        {
          code: "stage.invalid_secrets",
          message: `Invalid stage ${label}: secrets names must be non-empty`,
          category: "stage",
          stageId,
        },
      ]);
    }
    if (isForeverDeniedSecret(name)) {
      return loadFailure([
        {
          code: "stage.denied_secret",
          message: `Invalid stage ${label}: secret "${name}" is permanently denied and cannot be granted`,
          category: "stage",
          stageId,
        },
      ]);
    }
    if (seen.has(name)) {
      return loadFailure([
        {
          code: "stage.invalid_secrets",
          message: `Invalid stage ${label}: secrets contains duplicate name "${name}"`,
          category: "stage",
          stageId,
        },
      ]);
    }
    seen.add(name);
    decls.push(asEnv ? { name, as: "env" } : { name });
  }
  return loadSuccess(decls);
}
