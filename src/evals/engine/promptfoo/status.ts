import { locatePromptfoo } from "./locate.js";
import { checkNode } from "./nodeVersion.js";
import { ENGINE_INSTALL_COMMAND, PINNED_PROMPTFOO_VERSION } from "./pinned.js";

export type EngineStatus = {
  installed: boolean;
  version: string | null;
  pinned: string;
  node: string;
  nodeOk: boolean;
  path: string | null;
  installCommand: string;
};

export function engineStatus(opts: { home: string; nodeVersion?: string }): EngineStatus {
  const located = locatePromptfoo({ home: opts.home });
  const node = checkNode(opts.nodeVersion);
  return {
    installed: located.installed,
    version: located.installed ? located.version : null,
    pinned: PINNED_PROMPTFOO_VERSION,
    node: node.found,
    nodeOk: node.ok,
    path: located.installed ? located.dir : null,
    installCommand: ENGINE_INSTALL_COMMAND,
  };
}
