import { ConsumerAuthorization } from "../../identity/authorization.js";
import { createScopeAuthorizationEngine } from "../../identity/scope.js";
import { ConsumerIdentityStore } from "../../identity/store.js";
import type { ConsumerAuthorization as ConsumerAuthorizationType } from "../../identity/authorization.js";
import { evalFixturePrincipal, EVAL_CONSUMER_WORKSPACE, type EvalFixturePrincipal } from "./fixtureCatalog.js";
import { createEvalFixtureAdapter, type EvalFixtureAdapterOptions } from "./fixtureAdapter.js";

export type EvalConsumerHandle = {
  auth: ConsumerAuthorizationType;
  consumerSessionId: string;
  principal: EvalFixturePrincipal;
  close: () => void;
};

export function createEvalConsumerSession(input: {
  principalId: string;
  agentId: string;
  conversationSessionId: string;
  adapterOptions?: EvalFixtureAdapterOptions;
}): EvalConsumerHandle {
  const principal = evalFixturePrincipal(input.principalId);
  if (!principal) throw new Error(`eval principal ${input.principalId} is not in the fixture catalog`);
  const store = new ConsumerIdentityStore(":memory:", EVAL_CONSUMER_WORKSPACE);
  const auth = new ConsumerAuthorization(
    store,
    createScopeAuthorizationEngine(),
    createEvalFixtureAdapter(input.adapterOptions),
    "eval_fixture_v1",
  );
  store.registerService(`eval-${input.principalId}`, principal.accountId, {
    ...principal.permission,
    agents: [input.agentId],
  });
  const live = store.openServiceAuthority(input.agentId);
  auth.bind(input.conversationSessionId, live.sessionId, input.agentId, live.principal.revision);
  return {
    auth,
    consumerSessionId: live.sessionId,
    principal,
    close: () => store.close(),
  };
}