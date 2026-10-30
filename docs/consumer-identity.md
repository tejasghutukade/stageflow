# Consumer identity and protected web conversations

**Status: experimental.** Identity is opt-in. The CLI does not provision connections, and the public chat page does not include a sign-in button. Operators manage connections, assignments, and audit on the Identity page. A Host embedder supplies `consumerAuthorization` to `startUiServer`.

Consumers are people using a business's agents. They are separate from Workspace owners and operators. This increment does not change Cloud's Supabase owner login or move passwords, MFA or account administration into Stageflow.

## Implemented boundary

- Asymmetric, server-verified existing-login handoff using `jose`, not a handwritten token verifier.
- OIDC Authorization Code + PKCE admission through `openid-client`, including ID Token signature checks. Discovery stays on the issuer origin and does not follow redirects.
- Persistent consumer mappings, session and grant revocation, replay protection, and immutable conversation bindings in a Workspace-bound SQLite database. Only a digest of the chat bearer is stored.
- Trusted runtime permission checks intersecting the consumer scope, admission-time Access Grant limits, agent tool grants and existing approvals.
- A provider-neutral `AuthorizationEngine` and a local Cerbos PDP adapter. Only an explicit, correlated allow is accepted; an error denies.
- One read-only binding, `orders.status`, with authoritative ownership/assignment metadata and a constrained downstream API contract.
- Reauthorization before protected history, model input, tool execution, after approval waits and before response delivery. Previously disclosed resource versions are rechecked before history reuse.

Generic MCP, filesystem, shell, browser, skills, project context, shared memory, pipelines, and channels are not supported protected execution paths. A consumer-safe agent is a Pi agent with none of those capabilities. The only tool grant it may declare is `orders.status`, represented as `tools.mcp.orders: [status]`. A protected child agent may continue only with a narrower grant for the same person. A scheduled run may use an explicit service identity configured on the Host. The Pi runtime removes ambient capabilities and installs the trusted order tool plus allowlisted consumer-safe child agents. Eval sessions retain their existing independent gate; this is not consumer-eval support.

Anonymous public chat is limited to tool-less agents without shared private context. Tool-enabled anonymous publications now return `identity.setup_required`. New anonymous threads use source `web_public`; legacy `web` histories are not adopted because they may contain unscoped private results. Back up existing histories and migrate only after ownership has been established; do not simply relabel old rows.

## Trusted Host setup

The public package exports `ConsumerIdentityStore`, `ConsumerAuthorization`, `prepareOidcConnection`, `createCerbosAuthorizationEngine`, `createOrderApiAdapter`, their contract types, and `startUiServer`. Embedders must consume these exports, not private runtime imports.

1. Create a `ConsumerIdentityStore(filename, workspaceId)` in a persistent, owner-only Host data directory. One database belongs to exactly one Workspace; reopening it under another Workspace fails. Back up this database with the Host conversation store. Losing either is not a reason to reconstruct authority from chat text.
2. Register a trusted `HandoffConnection` with `store.registerHandoff`. Pin its exact issuer, audience, agent ID, asymmetric algorithms and public JWKS. Never accept registration parameters from an unauthenticated browser. Handoff registration activates immediately and can be disabled. OIDC stays a draft until discovery and a recorded test sign-in succeed, then `activateOidc`. Rotating an OIDC client secret does not widen existing sessions. Operators can do this from `/api/identity` and the console Identity page (`#/identity`). Secrets and private keys are write-only.
3. Populate an authoritative directory mapping with `store.assign(connectionId, subject, accountId, mappingSource, permission)`. The mapping source records trusted provenance. An email claim is not an account mapping. Do not infer ownership from OAuth scopes, an IdP group name or user-provided account IDs.
4. Choose an authorization engine and a trusted `OrderDataAdapter`. `createScopeAuthorizationEngine()` decides `own`, `assigned`, `selected`, and `workspace` in-process. `createCerbosAuthorizationEngine({ endpoint, allowLoopback })` is the other adapter; its policy must encode those same relations. A protected read and the operator preview both require the scope relation and an engine allow. The engine can narrow that decision. It cannot grant an order the relation refuses, including when the engine returns true for every check. Construct `ConsumerAuthorization(store, engine, orders, "consumer_v1")` and pass it to the Host as `consumerAuthorization`. The optional last argument enables loopback HTTP for a local OIDC fixture only.
5. Publish an enabled Pi agent with `web_chat.access: authenticated` and the `orders.status` grant (represented by `tools.mcp.orders: [status]`). No generic MCP server is opened for that grant in a consumer turn. Leave the unsupported capabilities listed above off.

A permission contains `agents`, `actions` (`conversation:use`, `order:read`), and a scope:

| Scope | Required authoritative relation |
|-------|----------------------------------|
| `own` | The mapped business account owns the order |
| `assigned` | The mapped support account appears in the order's assignment list. The owner is allowed only when that account is also on the list |
| `selected` | The order is explicitly listed in `resources` |
| `workspace` | Explicit supervisor access within this Workspace, never across Workspaces |

Admission creates a bounded Access Grant from those permissions. Later permission revisions invalidate old sessions instead of expanding them. `store.revoke(kind, id)` accepts `session`, `principal`, `connection` or `grant`. Local changes abort active protected turns; all execution and disclosure paths also re-read durable authority. `GET /api/identity/audit` lists allow and deny codes for operators. It has no order payloads, tokens, or secrets. Public chat cannot call it. Two operators pass `expectedRevision`; a stale write returns `identity.conflict` and does not overwrite.

## Existing-login handoff

The customer's server must first authenticate its user using its own existing login. It then signs a one-time JWT with a registered asymmetric key, using protected header `typ: stageflow-agent-handoff+jwt` and these claims:

| Claim | Contract |
|-------|----------|
| `iss`, `aud` | Exact registered issuer and audience |
| `sub` | Stable IdP/application subject with a preconfigured account mapping |
| `workspace`, `agent` | Exact Host Workspace and registered agent |
| `iat`, `exp` | Integer times; maximum lifetime 300 seconds; no future issue time |
| `jti` | Unique assertion ID, consumed atomically and durably |

Supported algorithms are ES256, RS256 and EdDSA, restricted to the connection's allowlist. Private or symmetric keys are refused in stored JWKS. A downstream API access token or a token with another `typ` is not a login assertion. Never send the application signing key to the browser or model.

The embedded client sends:

```http
POST /api/public/chat/:slug/admission
Content-Type: application/json

{"connectionId":"<registered-connection>","assertion":"<signed-one-time-assertion>"}
```

Success returns `201 { token, tokenType: "Bearer", expiresIn }`. Use `Authorization: Bearer <token>` on thread list/create/history and message requests. Do not put this token in a URL, model prompt, downstream credential or log. The header replaces `X-Visitor-Id` as conversation authority for authenticated agents. Allowed browser origins still apply; deploy the public endpoint behind TLS. The metadata endpoint returns only the published name and greeting without authentication.

The handoff bearer expires with the verified proof, within five minutes. OIDC admission issues a separate Stageflow session of at most one hour. The provider ID Token and access token are not returned and are not credentials for customer APIs. Stale OIDC evidence can be refreshed once when the provider issued a refresh token; otherwise the person signs in again. Conversations are not adopted into a replacement session. Restarting a Host preserves bindings, replay protection and revocation, but does not extend expiry. The binding includes the agent revision; changing the agent definition invalidates existing protected conversations.

Protected assistant output is buffered until current authorization is checked, not streamed straight from the model. NDJSON uses the existing `delta`, `waiting`, `done` and `error` shapes. A denial after headers have been sent is an error frame, not a new HTTP status. Safe codes are `identity.verification_required` (401), `identity.not_available` (404), `identity.setup_required` (503), and `identity.conflict` (409 on the operator API).

## Read-only order API contract

`createOrderApiAdapter` takes a fixed trusted HTTPS `endpoint`, an `audience`, a server-side `credential(workspaceId)` resolver and a `signContext(claims)` callback. Pass `allowLoopback: true` only for the local fixture. Requests cannot select endpoints, identities, roles, credentials, Workspace IDs or decisions. Redirects are refused; responses are bounded to 64 KiB and requests to three seconds. The Host's downstream credential is distinct from the chat bearer, a provider ID token, and an administrator credential.

The customer integration must implement both fixed endpoints:

- `POST /stageflow/order-ownership`, with `{ workspaceId, orderId }` and the downstream credential. Return **metadata only**: `{ id, workspaceId, ownerAccountId, assignedAccountIds, version }`. This is the authoritative contract consulted before any private payload read. The endpoint must enforce the credential's Workspace and never return unrestricted records.
- `POST /stageflow/order-status`, with `{ orderId, expectedVersion }`, the downstream credential and a `Stageflow-Authorization` signed context. Atomically validate the context, current Workspace/ownership/assignment and expected version before selecting private columns. Return `{ ownership, receipt: { principalId, grantId }, status: { orderId, status, updatedAt } }`. A mismatch must deny, not fetch and ask the model to filter.

The context includes issuer/audience, principal, Workspace, agent, grant, mapped account, action, resource ID/version, scope, permission revision, a unique ID, and at most a 30-second expiry capped by the admission expiry. The downstream service must verify the signature, exact audience/action/resource, expiry and its own authoritative relation. Only the minimised status is returned to the model; credentials and ownership metadata are not.

Stageflow validates the receipt and metadata and rechecks authorization after the read. The local order fixture checks the signed context, the 30-second lifetime, and the ownership version before it returns a private status. An ownership change between the metadata read and the status read denies the request and does not include the private payload. That fixture is not a live customer system. A customer's API still has to implement this contract itself.

## Local Cerbos fixture

The repository includes `policy-samples/consumer-orders.yaml`, a versioned `consumer_v1` policy, and a hardened loopback-only PDP fixture:

```sh
docker compose -p sfidentitytest -f docker-compose.consumer-identity.yml up -d --wait
IDENTITY_CERBOS_SMOKE=1 npx vitest run tests/identity.conversation.test.ts
docker compose -p sfidentitytest -f docker-compose.consumer-identity.yml down
```

Run cleanup even when a test fails. Cerbos is pinned to an image digest, telemetry is off, policy mounts are read-only and the HTTP port binds only to loopback. This fixture targets a native Host; it is not a Cloud deployment or a container-to-container networking recipe. Policy activation/rollback and deployment health gating are not implemented. Unknown policy versions or PDP failures deny.

## OIDC sign-in

`store.registerOidc` stores a draft connection. The client secret is a separate argument and is never part of `oidcSetup` or `oidcConnection`. Call `prepareOidcConnection(store, id, allowLoopback)` to discover the issuer, then `store.activateOidc(id)`. `allowLoopback` is only for a local fixture; production issuers are HTTPS and must not be private, link-local, or metadata addresses. Every discovery, key-set, and token URL must stay on that issuer origin.

The embedded client starts sign-in with:

```http
POST /api/public/chat/:slug/oidc/start
Content-Type: application/json

{"connectionId":"<registered-connection>"}
```

Success returns `200 { authorizationUrl }` and a `Secure`, `HttpOnly`, `SameSite=Lax` cookie named `sf_oidc`. Send the browser to `authorizationUrl`. The provider redirects to the registered callback, which must be this Host's `/api/public/chat/:slug/oidc/callback`. The callback returns the same `201 { token, tokenType, expiresIn }` shape as handoff admission. A callback without the matching cookie does not consume the server-side PKCE transaction. State, nonce, and the authorization code are single-use.

The provider `sub` claim is the only accepted subject. It must already have an `assign` mapping. Email, groups, and any Workspace claim in the ID Token are not authority. Protected order reads treat OIDC evidence as fresh for five minutes (`freshnessMs`). After that, one refresh against the same issuer may run when a refresh token was stored. A narrowed child uses the parent's refresh token. The token stays on the parent session, and a successful refresh updates evidence on both. If refresh is missing or fails, the person signs in again. A still-valid provider access token is not a chat bearer and is not proof of current access. An optional revocation URL on the issuer origin can return `{ "active": false }` and block the next protected action. When no revocation source is configured, operator responses say: Local revoke is immediate. Upstream removal is not detected.

The hosted acceptance fixture is one loopback provider, `stageflow-hosted-test-idp`. A successful sign-in records audit reason `oidc_verified` after issuer, audience, signature, nonce, and PKCE checks. That fixture is not a certification of every enterprise identity system. A cancelled, replayed, or cross-Workspace callback does not open a session.

## Child agents and unattended runs

A protected parent may delegate to a child that is itself a consumer-safe Pi agent. The child keeps that person, Workspace, and grant, and may only narrow actions, orders, or expiry. It cannot become a service identity. Revoking the parent grant stops the child before the protected tool runs.

`store.registerService(id, accountId, permission)` configures work that runs when no customer is present. A turn with `source: "schedule"` uses only that active grant. It does not reuse the last customer session, and a Workspace owner's console session is not permission. Public chat rejects a `service:` subject. Revoking the service grant stops the next run.

## Self-hosted and hosted

A self-hosted Host and a hosted Workspace both construct `ConsumerAuthorization` from this package. The public exports are `ConsumerIdentityStore`, `ConsumerAuthorization`, `prepareOidcConnection`, `createCerbosAuthorizationEngine`, `createOrderApiAdapter`, and `startUiServer`. Cloud provisions the Host, routes a customer to a Workspace, and resolves downstream secrets through its vault. It must not reimplement admission, grants, or the order decision. Upgrade Cloud only after a release of this package that includes these exports. The Cloud repository is still on the previously published package and was not changed here. Workspace-owner sign-in stays the existing Supabase login. No paid authentication or authorization product is required.

Permission expiry and revocation do not retract information that was already disclosed. Search, export, memory, attachments, browser files, and outbound delivery stay unavailable until each one checks the current person before data reaches a model or a recipient. SAML, SCIM, and replacing Workspace-owner login are out of scope. Policy activation and rollback beyond assignment revisions are not a separate console.
