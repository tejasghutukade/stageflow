import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { classifyRealPathContainment } from "../runstore/workspaceLayout.js";
import type { StageRunInput } from "./port.js";

export const CHECKOUT_CONTEXT_WINS =
  "The stage assignment wins where it conflicts with the file.";

const CHECKOUT_CONTEXT_MAX_CHARS = 20_000;

/**
 * Extra context from `<checkoutRoot>/AGENTS.md` when the stage opts in.
 * A missing file is no extra context. The read does not walk above the checkout.
 */
export async function readCheckoutAgentsContext(
  input: StageRunInput,
): Promise<string | undefined> {
  if (input.stage.checkout_context !== true) return undefined;
  const root = input.roots.checkoutRoot;
  if (root === undefined || root.trim() === "") return undefined;
  const filePath = path.join(root, "AGENTS.md");
  let linked = false;
  let regularFile = false;
  let hardLinked = false;
  try {
    const st = await lstat(filePath);
    linked = st.isSymbolicLink();
    regularFile = st.isFile();
    hardLinked = st.nlink > 1;
  } catch {
    return undefined;
  }
  if (linked || !regularFile || hardLinked) return undefined;
  const containment = await classifyRealPathContainment(filePath, root);
  if (containment.status !== "inside") return undefined;
  let text: string;
  try {
    text = await readFile(containment.realPath, "utf8");
  } catch {
    return undefined;
  }
  const body = text.slice(0, CHECKOUT_CONTEXT_MAX_CHARS).replace(/\s+$/, "");
  return ["# Checkout context (AGENTS.md)", body, "", CHECKOUT_CONTEXT_WINS].join("\n");
}
