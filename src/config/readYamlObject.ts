import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export async function readYamlObject(
  filePath: string,
): Promise<Record<string, unknown>> {
  return parseYaml(await readFile(filePath, "utf8")) as Record<string, unknown>;
}
