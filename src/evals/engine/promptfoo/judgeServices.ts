import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCredentialBinding } from "../../../runtime/credentialBinding.js";
import type { JudgeMapping } from "../../judgeProviders.js";
import { readAuthKey } from "../../providerKeys.js";
import type { JudgePrice } from "./normalize.js";

export type JudgeKeyResolver = (
  mapping: JudgeMapping,
  projectRoot: string,
) => Promise<string | undefined> | string | undefined;

export type JudgePriceLoader = (
  modelIds: readonly string[],
  projectRoot: string,
) => Promise<Map<string, JudgePrice>>;

export const defaultResolveJudgeKey: JudgeKeyResolver = (mapping, projectRoot) => {
  const fromStore = readAuthKey(resolveCredentialBinding(projectRoot).authPath, mapping.stageflowProvider);
  if (fromStore !== undefined) return fromStore;
  const fromEnv = process.env[mapping.envVar];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
};

export const defaultLoadJudgePrices: JudgePriceLoader = async (modelIds, projectRoot) => {
  const prices = new Map<string, JudgePrice>();
  if (modelIds.length === 0) return prices;
  try {
    const authPath = resolveCredentialBinding(projectRoot).authPath;
    if (!existsSync(authPath)) return prices;
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: path.join(path.dirname(authPath), "models.json"),
      refreshOnCreate: false,
    });
    for (const id of modelIds) {
      const slash = id.indexOf("/");
      const model = runtime
        .getModels(id.slice(0, slash))
        .find((candidate) => candidate.id === id.slice(slash + 1));
      const cost = model?.cost;
      if (cost !== undefined && typeof cost.input === "number" && typeof cost.output === "number") {
        prices.set(id, { inputPerMillion: cost.input, outputPerMillion: cost.output });
      }
    }
  } catch {
    return prices;
  }
  return prices;
};
