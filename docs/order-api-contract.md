# Customer resource API contract

This page is for the engineer who owns the system that holds customer data (orders, accounts, and similar resources). Stageflow never reads your database. For a protected agent, the Host calls fixed `POST /stageflow/…` endpoints on an API **you** run. Each **resource type** (orders first, then account profile) is declared in Host identity settings with path suffixes appended to one base URL and one audience. The order endpoints below are the reference implementation; account profile uses the same ownership + signed-read pattern. A separate endpoint maps a channel sender to an account. Operators connect the API from **Identity → Setup**; see [Console: Identity](console-identity.md#setup).

Read-only resource tools ship as `orders.status`, `orders.list`, and `account.profile`. Writes (returns, address change) are unfinished and not part of this contract.

## What you get, and what you must enforce

Stageflow decides who the person is (a verified sign-in mapped to an account) and what access level they were given. For each resource read it asks your API:

1. **Who owns this resource?** Metadata only (`POST /stageflow/order-ownership` or `/stageflow/account-ownership`). Stageflow compares the answer with the person's access level and refuses before any private data moves.
2. **What is the private payload?** Called only after the first answer allowed the read (`POST /stageflow/order-status` or `/stageflow/account-profile`). This call carries a signed token that names the person, the resource and its version.
3. **List (orders only).** `POST /stageflow/orders-list` returns resource ids for the mapped account only. The model cannot widen the list; the Host ignores any account or order id the model supplies.

Your API is the second line of defence, not a pass-through. It must check the token, check ownership itself, and refuse on any mismatch. A model never sees an order that either side refused.

## Transport

| Rule | Value |
|------|-------|
| Address | The base address saved in Setup, for example `https://orders.example.com`. Paths below are appended to it |
| Scheme | `https` only. Plain `http` on `localhost`, `127.0.0.1` or `::1` is accepted only when the Host runs with `STAGEFLOW_IDENTITY_ALLOW_LOOPBACK=1` (local testing) |
| Method and body | `POST`, `Content-Type: application/json` |
| Redirects | Refused. Answer on the exact address |
| Timeout | 3 seconds per call |
| Reply size | At most 64 KiB |
| Status code | `2xx` with a JSON body is a reply. Anything else is a refusal. Do not return `200` with an error body |

## Credential

Every call sends `Authorization: Bearer <credential>`. The credential is the value an operator typed into Setup. It is stored write-only on the Host and sent only to this address.

- Issue a **dedicated service credential** for Stageflow, scoped to these endpoints and to the Workspace.
- Do not accept a person's login token, an OIDC ID token, a Stageflow chat bearer or an administrator key here. Stageflow never sends those, and a credential that also works elsewhere is a larger blast radius than you want.
- Rotate it in Setup (**Edit settings**) and in your API together.

## Finding and error codes (Host)

| Code | Meaning |
|------|---------|
| `identity.not_available` | Any downstream refusal, timeout, malformed body, ownership mismatch, or scope denial. Shown to the person; not your API's error text |
| `identity.setup_required` | Identity off, order API not configured, or the agent is not consumer-safe |
| `assurance_insufficient` | Channel assurance too weak for the tool (for example email without step-up) |
| `step_up_sign_in_missing` | Step-up needed, but the agent has no active OIDC connection on its protected web chat, so no link was issued |
| `order_read` / `order_list` / `account_read` | Audit allow reasons after a successful read, list, or profile fetch |

Extra JSON fields, wrong types, redirects, non-`2xx` responses, and bodies over 64 KiB are all treated as refusal (`identity.not_available`).

## Orders: endpoint 1 — ownership

`POST /stageflow/order-ownership`

Request:

```json
{ "workspaceId": "local", "orderId": "ord_1001" }
```

`workspaceId` is the Workspace that owns the Host (`local` unless `STAGEFLOW_WORKSPACE_ID` is set; the Identity footer shows it). Your API should scope its lookup to the Workspace tied to the credential and refuse a mismatch.

Reply with **metadata only**:

```json
{
  "id": "ord_1001",
  "workspaceId": "local",
  "ownerAccountId": "acct_1001",
  "assignedAccountIds": ["acct_support_4"],
  "version": "7"
}
```

| Field | Meaning |
|-------|---------|
| `id` | The order id you were asked about. Must equal `orderId` |
| `workspaceId` | Must equal the requested `workspaceId` |
| `ownerAccountId` | The business account that owns the order. This is the id operators map people to on **People & access** |
| `assignedAccountIds` | Accounts assigned to the order, such as support staff. An empty array is fine. At most 1000 |
| `version` | An opaque string that changes whenever ownership or assignment changes (a row version or an ETag-like value) |

The reply is checked strictly. A missing field, a wrong type or an **extra field** makes Stageflow refuse the read. Never put order contents, customer names or addresses in this reply. Return a `404` when the order does not exist or is not in that Workspace; do not reveal which.

## Orders: endpoint 2 — status

`POST /stageflow/order-status`

Request body and headers:

```http
POST /stageflow/order-status
Authorization: Bearer <credential>
Stageflow-Authorization: <signed token>
Content-Type: application/json

{ "orderId": "ord_1001", "expectedVersion": "7" }
```

Do all of this **before** you select any private column, and in one atomic step if you can:

1. Verify the `Stageflow-Authorization` token (next section).
2. Check the token's `resource` equals `orderId`, and `resource_version` equals `expectedVersion`.
3. Load the order's **current** owner, assignments and version from your own data.
4. Refuse unless the current version equals `expectedVersion`, the Workspace matches, and the token's `account` is allowed to read this order under the token's `scope` (below).
5. Only then read the status.

Reply:

```json
{
  "ownership": {
    "id": "ord_1001",
    "workspaceId": "local",
    "ownerAccountId": "acct_1001",
    "assignedAccountIds": ["acct_support_4"],
    "version": "7"
  },
  "receipt": { "principalId": "<token sub>", "grantId": "<token grant>" },
  "status": { "orderId": "ord_1001", "status": "Shipped", "updatedAt": "2026-10-30T12:00:00.000Z" }
}
```

| Field | Rule |
|-------|------|
| `ownership` | Same shape as endpoint 1, read at the moment you answered. Stageflow compares it with what it saw before and refuses if the owner, assignments or version moved |
| `receipt` | Echo the token's `sub` and `grant` exactly. This proves your API acted on this token |
| `status.orderId` | The order id |
| `status.status` | Short text, at most 200 characters. This is the only order content a model sees. Return the minimum the agent needs, such as "Shipped" |
| `status.updatedAt` | ISO 8601 date-time |

As with endpoint 1, extra fields are refused. Stageflow also re-checks the person's permission after the read, so a revocation that happens during the call still stops the answer from being delivered.

## Orders: endpoint 3 — list

`POST /stageflow/orders-list`

Request (the Host always sends the mapped account; values from the model are ignored):

```json
{ "workspaceId": "local", "accountId": "acct_1001" }
```

Reply:

```json
{ "resources": [{ "id": "ord_1001", "version": "7" }] }
```

| Field | Rule |
|-------|------|
| `resources` | At most 1000 entries. Each entry has exactly `id` and `version`. Extra fields fail closed |
| Scope | Return only orders the credential's workspace ties to `accountId`. Never echo another account's orders because the model named an id |

The Host re-checks each listed id with endpoint 1 and scope rules before returning anything to the model. If any row does not belong to the caller, the whole list is refused.

## Account: ownership and profile

`POST /stageflow/account-ownership` — request `{ "workspaceId", "accountId" }`. Reply uses the same five-field ownership shape as orders, with `id` and `ownerAccountId` equal to the account id.

`POST /stageflow/account-profile` — same transport and signed token rules as order status, with `action` `account:read` in the token. Request `{ "accountId", "expectedVersion" }`. Reply:

```json
{
  "ownership": { "...": "same as ownership endpoint" },
  "receipt": { "principalId": "<token sub>", "grantId": "<token grant>" },
  "profile": { "accountId": "acct_1001", "displayName": "Jane" }
}
```

`displayName` is at most 200 characters. The Host never uses a model-supplied account id; only the signed-in principal's account is read.

## Adding another resource type

Configure a row in Host `identity/settings.json` under `resources` (id, path suffixes, tool ids). Implement the matching `/stageflow/…` endpoints on your API. No Core code change is required when the new type follows the same ownership, optional list, and signed-read pattern.

## The signed token

`Stageflow-Authorization` is a compact JWT signed with the Host's ES256 signing key. The public key is shown in **Identity → Setup → Order API** with a **Copy public key** button, as a JWKS you can load directly.

Header:

| Field | Value |
|-------|-------|
| `alg` | `ES256` |
| `typ` | `stageflow-order-context+jwt` |
| `kid` | The key id shown in Setup |

Claims:

| Claim | Meaning |
|-------|---------|
| `iss` | Always `stageflow` |
| `aud` | The audience saved in Setup. Reject any other value |
| `sub` | Stageflow's id for the person's identity record. Not the sign-in subject and not an email |
| `workspace` | The Workspace |
| `agent` | The agent the person is talking to |
| `grant` | The grant this read belongs to |
| `account` | The business account the person acts as. This is what you compare with `ownerAccountId` and `assignedAccountIds` |
| `action` | `order:read` on order status and list calls; `account:read` on account profile. Reject anything else |
| `resource`, `resource_version` | The order and the version Stageflow saw. Must match the request body |
| `scope` | `own`, `assigned`, `selected` or `workspace`. How broad the person's access is |
| `permission_revision` | Increases whenever the person's access is edited |
| `iat`, `exp` | Integer seconds. Valid for at most 30 seconds |
| `jti` | Unique per token |

How to apply `scope` against your own data:

| `scope` | Allow only when |
|---------|-----------------|
| `own` | `account` equals the order's current owner |
| `assigned` | `account` is in the order's current assigned accounts |
| `selected` | Stageflow has already confirmed the order is on the person's list. Still apply the Workspace and version checks |
| `workspace` | The order is in the same Workspace |

Stageflow has already applied these rules before it calls you, so a correct API agrees with it. Apply them anyway: that is what keeps a bug or a stale cache on either side from leaking an order.

### Verify it (Node)

```js
import { createLocalJWKSet, jwtVerify } from "jose";

// Paste the JWKS from Setup into your config. Reload it after you rotate the key.
const keys = createLocalJWKSet(JSON.parse(process.env.STAGEFLOW_CONTEXT_JWKS));
const seen = new Map(); // jti -> exp, to refuse a replay inside the 30 second window

export async function verifyStageflowContext(token, expected) {
  const { payload } = await jwtVerify(token, keys, {
    issuer: "stageflow",
    audience: process.env.STAGEFLOW_CONTEXT_AUDIENCE, // the audience saved in Setup
    algorithms: ["ES256"],
    typ: "stageflow-order-context+jwt",
    maxTokenAge: 30,
    clockTolerance: 0,
    requiredClaims: ["sub", "workspace", "agent", "grant", "account", "action", "resource", "resource_version", "scope", "jti", "iat", "exp"],
  });
  if (payload.action !== "order:read" && payload.action !== "account:read") throw new Error("wrong action");
  if (payload.action !== expected.action) throw new Error("wrong action");
  if (payload.resource !== expected.resource || payload.resource_version !== expected.expectedVersion) throw new Error("wrong resource");
  if (payload.exp - payload.iat > 30) throw new Error("token lives too long");
  const now = Date.now() / 1000;
  for (const [jti, exp] of seen) if (exp < now) seen.delete(jti);
  if (seen.has(payload.jti)) throw new Error("replay");
  seen.set(payload.jti, payload.exp);
  return payload;
}
```

Any other language works the same way: verify an ES256 signature against the published key, then check `aud`, `typ`, `exp`, `action`, `resource` and `resource_version`.

## Endpoint 3: resolve a channel sender

`POST /stageflow/resolve-sender`

Called when a person messages an agent on iMessage, Telegram or email and that agent has a channel identity connection. The same transport rules, credential, timeout and size limit apply. Stageflow calls this on the first message of a session and again after five minutes. It does not follow redirects.

Request:

```json
{ "workspaceId": "local", "channel": "imessage", "sender": "+14155550123" }
```

| Field | Meaning |
|-------|---------|
| `workspaceId` | The Workspace that owns the Host, the same value as on the order endpoints |
| `channel` | `imessage`, `telegram`, `agentmail` or `email` |
| `sender` | The provider's sender, already normalized: E.164 (`+14155550123`), a Telegram numeric user id, or a lowercased email address |

Reply with **only** the account id when the sender is a customer:

```json
{ "accountId": "cus_881" }
```

`accountId` is the same kind of id you return as `ownerAccountId`. It is one to 128 characters from `A–Z`, `a–z`, `0–9`, `_` and `-`. An extra field, a wrong type or any status other than `2xx` is treated as "we could not match this sender", except `404`, which means the sender is not a customer. Do not put a name, a message or an error explanation in the body. A timeout, a redirect or a connection error is also treated as not matched. Stageflow then sends the operator's fixed reply and does not run the agent.

A match is cached for five minutes. After that, a sender you no longer return is refused on the next message. An operator revoke in Stageflow wins over a match from this endpoint.

## Key rotation

**Rotate key** in Setup replaces the signing key immediately. Tokens signed with the old key stop verifying on the Host's next read, and your API will not trust the new key until you load it. Order:

1. Rotate in Setup and copy the new public key.
2. Load it into your API. If you can, trust both keys for a short overlap, matching on `kid`.
3. Run **Test your order API** to confirm the Host can still sign and verify.

Reads between the rotation and step 2 fail closed: the person sees that the order is unavailable.

## Errors and what the person sees

Stageflow does not show your error text to the person or the model. Any non-`2xx`, timeout, redirect, oversized, malformed or mismatched reply becomes the same answer: the order is unavailable. Your own logs are the place to see why. The Host's Identity activity records an `allow` or `deny` code, never an order payload.

## Checklist before you connect

- [ ] A dedicated credential that works only on these endpoints
- [ ] `ownership` returns metadata only, with exactly the five fields
- [ ] `status` verifies the token's signature, `aud`, `typ`, `exp`, `action`, `resource` and `resource_version` before reading private data
- [ ] `status` re-reads the current owner, assignments and version from your own data and refuses on any mismatch
- [ ] `status` echoes `sub` and `grant` in `receipt`
- [ ] The answer is the short status text only
- [ ] Replayed `jti` values are refused inside the 30 second window
- [ ] No redirects, responses under 64 KiB, answers inside 3 seconds

Then use **Test your order API** in Setup with a real order id. It calls only endpoint 1 and checks that the Host can sign and verify. Endpoint 2 is exercised only by a real protected chat. **Check access** does not call your API: it checks the access level and policy against ownership details you type in.

See also: [Consumer identity](consumer-identity.md) for the full security model, and [Protect an agent's chat with customer sign-in](guides-agents-protected-chat.md) for the end-to-end setup.
