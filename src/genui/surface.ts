import type Database from "better-sqlite3";
import type { SessionPublishBody, SessionPublishSuccess } from "../artifacts/sessionPublish.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import type { AgentDefinition } from "../config/loadAgent.js";
import type { ArtifactOwner } from "../artifacts/owners.js";
import { uiKeepsCardsInConversation } from "./kindsList.js";
import type { TurnBudget } from "./budget.js";
import type { CardSource } from "./cards.js";

/** What a caller lets the model do with generative UI. Every difference between callers is a value here. */
export type SurfacePolicy = {
  canPresent: boolean;
  /** Kinds present_ui accepts. live.html cards also need `htmlCardsReachable`. */
  kinds: readonly string[];
  /** Whether people who read this chat can reach the HTML card sandbox. Read when a card is drawn and when a prompt is built. */
  htmlCardsReachable: () => boolean;
  /** Cards live in the message (`ui.persistence: conversation`); otherwise a one-off program is saved as a session artifact. */
  cardsInConversation: boolean;
  /** present_ui may show a saved artifact by key. */
  canShowSaved: boolean;
  /** save_card is offered (the surface also needs `cards` and `artifacts`). */
  canSave: boolean;
  /** An anonymous visitor's session on a public chat link: a saved card stays in that conversation (session scope). */
  visitorSession?: boolean;
  canPublish: false | { kinds: readonly string[] };
  /** False when the kinds are only known per session (the Guide): the tool description stays neutral and the prompt lists them. */
  describeKinds: boolean;
};

export type ArtifactStoreAccess = {
  db: Database.Database;
  roots: readonly CatalogRoot[];
  /** Console link for a hash path (`/artifacts/...`), as the Host serves it. */
  consoleUrl: (hashPath: string) => string;
};

export type PublishPort = {
  /** Reads a `path` argument under the caller's own rules (a stage attempt's artifacts dir, an agent's project). */
  readPath: (rawPath: string) => Promise<Buffer>;
  publish: (body: SessionPublishBody) => Promise<SessionPublishSuccess>;
};

export type Surface = {
  /** Rate-limit key, from `surfaceKey`. */
  key: string;
  /** The conversation: an agent session id, a Guide thread id, a stage attempt. */
  id: string;
  /**
   * The owner this surface saves and presents artifacts as, and the only owner a publish_artifact `owner` argument may
   * name. Absent for a stage: its publish port applies the stage owner.
   */
  owner?: ArtifactOwner;
  /** True when artifacts this surface writes are hidden (an eval session). Set by the caller; absent means visible. */
  hiddenArtifacts?: (db: Database.Database) => boolean;
  projectRoot: string;
  policy: SurfacePolicy;
  /** The per-reply card count. */
  budget?: TurnBudget;
  /** The artifact store, for showing saved artifacts and saving one-off programs. Absent or undefined when the Host has none. */
  artifacts?: () => Promise<ArtifactStoreAccess | undefined>;
  publish?: PublishPort;
  /** The cards this conversation has shown, for save_card. */
  cards?: CardSource;
};

/** The one place a surface's rate-limit key is built. `caller` names the kind of surface (agent, guide, stage). */
export function surfaceKey(caller: "agent" | "guide" | "stage", id: string): string {
  return `${caller}:${id}`;
}

/** Kinds a one-off program may use right now: live.html only while its sandbox is reachable. */
export function inlineKinds(policy: Pick<SurfacePolicy, "kinds" | "htmlCardsReachable">): readonly string[] {
  return policy.htmlCardsReachable() ? policy.kinds : policy.kinds.filter((kind) => kind !== "live.html");
}

export function htmlSignal(signal: boolean | (() => boolean) | undefined): () => boolean {
  return typeof signal === "function" ? signal : () => signal === true;
}

/** The present_ui part of a policy, from an agent definition's `ui` block. */
export function uiPolicy(
  ui: AgentDefinition["ui"],
  htmlCardsReachable: () => boolean,
): Pick<SurfacePolicy, "canPresent" | "kinds" | "htmlCardsReachable" | "cardsInConversation" | "canShowSaved" | "describeKinds"> {
  const cardsInConversation = uiKeepsCardsInConversation(ui);
  return {
    canPresent: ui?.present === true,
    kinds: ui?.kinds ?? [],
    htmlCardsReachable,
    cardsInConversation,
    canShowSaved: !cardsInConversation,
    describeKinds: true,
  };
}

/** A surface that only publishes (a stage). */
export function publishOnlyPolicy(kinds: readonly string[]): SurfacePolicy {
  return {
    canPresent: false,
    kinds: [],
    htmlCardsReachable: () => false,
    cardsInConversation: true,
    canShowSaved: false,
    canSave: false,
    canPublish: { kinds },
    describeKinds: true,
  };
}
