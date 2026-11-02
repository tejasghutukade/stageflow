---
layout: default
title: Console - Identity
---

# Identity in the console

Identity is in the **Connect** group of the sidebar, after Connections. It is where an operator decides who may talk to a protected agent and what each person may see. This page walks each screen. For the concepts and the security model, see [Consumer identity](consumer-identity.md). For a start-to-finish setup, see [Protect an agent's chat with customer sign-in](guides-agents-protected-chat.md).

Status: experimental.

**Who this is for.** *Consumers* are the people who use a business's agents: its customers and its employees. They are not Workspace owners or operators, and this page does not change how you sign in to the console. A consumer proves who they are through your own login. Stageflow never holds their password or MFA.

| Route | Screen |
|-------|--------|
| `#/identity` | Identity: the turn-on screen, or the five tabs once identity is on |

Everything on the page is the operator's. The console shows ids, states and codes, never a secret, a token or the contents of an order.

## Turn on identity

A Host that manages identity itself (the `sf ui` command and the Docker image) opens on **Turn on identity for this Host**. The card lists what the button does:

- It creates a private database for this Workspace on this Host, in its data directory.
- It starts with the built-in access rules. Nothing is read from your systems until you connect an order API.
- It is reversible: you can turn identity off again and what you saved is kept.

Press **Turn on identity**. There is nothing to install and no restart; protected chats start working at once. If the page cannot reach identity for another reason, it shows the error code and a short explanation instead.

If the app that runs this Host passes in its own identity configuration, the screen instead says identity is **managed by that app**. The page then cannot switch it on, and the **Setup** tab is read-only. See [Consumer identity](consumer-identity.md#trusted-host-setup-embedders).

## The page

Once identity is on, the header shows **Add connection** and five tabs, each with a count where one makes sense: **Connections**, **People & access**, **Check access**, **Activity** and **Setup**. The footer shows the Workspace id (`workspace local` unless the Host sets `STAGEFLOW_WORKSPACE_ID`). You will need that id when you configure the app that signs people in.

A three-step strip appears above the tabs until you have finished the basics, and each step opens the matching tab:

1. **Connect a sign-in**: at least one live connection.
2. **Give people access**: at least one active person.
3. **Check and watch**: at least one recorded event.

## Connections

A connection is how Stageflow learns who is talking to an agent. There are three kinds:

| Kind | Use it when |
|------|-------------|
| **Existing login handoff** | Your own product already signs people in and embeds the agent. Your server vouches for the person with a short-lived signed token |
| **Sign in with your identity provider** (OIDC) | People sign in at Okta, Entra, Auth0, Google or any OpenID Connect provider. Passwords and MFA stay there |
| **Service identity** | An agent runs on a schedule with nobody signed in and needs a fixed, explicitly limited identity |

The list shows one row per connection: its id and kind, its issuer (or the agent for a service identity), its **Status**, and **Removals**. Click a row to open its drawer.

**Status**

| Shown | Meaning |
|-------|---------|
| **Active** | Accepting sign-ins |
| **Draft** | An OIDC connection that has not yet checked its provider |
| **Needs a test sign-in** | Provider reached; a test sign-in is still to be recorded |
| **Ready to go live** | Test recorded; press **Activate** |
| **Disabled** | Sign-ins are refused |

**Removals** says whether Stageflow checks the provider for people who were removed there (**Checked at provider**) or only knows about changes you make here (**Local only**). See [Catch removals at the provider](#the-connection-drawer).

### Add connection

**Add connection** opens a dialog with the three kinds as cards. Fields are validated as you type, and **Register** stays disabled until the form is valid.

All kinds:

- **Connection id**: letters, numbers, `-` and `_`, up to 64. It appears in activity entries and cannot be reused.
- **Agent**: the agent people talk to. Choose from your agents; if the console cannot list them it becomes a text field.

**Existing login handoff**

| Field | What to enter |
|-------|---------------|
| Issuer | The name your app puts in the token's `iss` claim |
| Audience | The `aud` claim, exactly as your app signs it |
| Signing algorithms | `ES256`, `RS256` and/or `EdDSA`. Tokens signed with any other algorithm are refused |
| Public keys (JWKS) | Your app's **public** key set. The dialog counts the keys it finds and refuses private key material. The set is write-only: it is not shown again after you register |

The handoff connection is active as soon as it is registered.

**OIDC**

| Field | What to enter |
|-------|---------------|
| Issuer URL | Your provider's HTTPS issuer, for example an Okta or Entra tenant |
| Client id | From the provider's app registration |
| Client secret | 16 to 512 characters on one line. Sent once, stored on the Host and never shown again |
| Redirect URI | Prefilled from the agent's chat link. Add this exact URL to the provider's allowed callbacks |
| ID token signing algorithms | Most providers sign with `RS256` |

OIDC is saved as a **draft** and goes live only after the steps in the drawer.

**Service identity**

| Field | What to enter |
|-------|---------------|
| Business account | The account this identity acts as in your order system |
| Access level | One of the four levels in [People & access](#people--access) |

A service identity is used only by scheduled runs. It is never available to anyone through public chat.

### The connection drawer

Opening a connection shows what applies to its kind.

- **Go live** (OIDC, until active). Three steps:
  1. **Check the provider**: Stageflow reads the issuer's discovery document and keys. A failure here means the issuer URL is wrong or not reachable.
  2. **Try a test sign-in**: sign in once through the provider yourself, then press **Record test sign-in**.
  3. **Activate**: enabled only after a test is recorded. A failed test never replaces a connection that is already active.
- **Register this callback at your provider** (OIDC). The callback path with a **Copy** button. Put your public address in front of it.
- **What your app must send** (handoff). The claims your app signs: `iss` and `aud`, `sub`, `workspace` and `agent`, and `exp` and `jti`. A token lives five minutes at most and works once.
- **Details**. Kind, status, issuer, callback, the checks Stageflow applies to the issuer and the revocation note.
- **Catch removals at the provider** (OIDC). By default Stageflow learns of a removal only when you revoke here: *Local revoke is immediate. Upstream removal is not detected.* Give a **Revocation URL** on the issuer's origin that answers `{ "active": false }` for a removed person, and the next protected action is blocked. **Remove source** goes back to local-only.
- **Client secret** (OIDC). **Rotate…** replaces the stored secret. Rotating does not widen existing sessions.
- **Disable**. Stops new sign-ins from this connection. Access you saved for people on it is kept. It asks you to confirm.

## People & access

Signing in proves who someone is. This tab decides what they may see, by mapping their sign-in to a business account and giving that account an access level.

The table shows, for each person: the **sign-in subject** and its connection, the **account** they act as, what they **can see**, and their **status** with the revision number. Search filters by person, account or connection. Each edit raises the revision.

### Give someone access

**Give someone access** (or **Edit**, or **Restore…** on a revoked person) opens a dialog:

| Field | What to enter |
|-------|---------------|
| Sign-in connection | A live connection |
| Person (subject) | The stable user id the sign-in sends as `sub`. **Not an email address** |
| Business account | The account id this person acts as in your order system. Stageflow never infers it from an email, a group name or an OAuth scope |
| Agents they can use | One or more agents. Defaults to the connection's agent |
| What can they see? | An access level |

**Access levels**

| Level | The person sees | Typical use |
|-------|-----------------|-------------|
| **Their own records** | Orders owned by their account | A customer |
| **Assigned records** | Orders where their account is on the assignment list | Support staff covering customers |
| **Specific records** | Only the order ids you list | A contractor handed escalated orders |
| **Everything in this workspace** | Every order in this business, never another Workspace. Shown with a **Broad** tag and a warning | A supervisor |

Saving a change makes a new revision and ends the person's open chats, so a change narrows or widens access from their next message, never in the middle of one. Two operators editing the same person at once are protected: the second save fails with *Someone else changed this just now* and overwrites nothing.

**Revoke…** asks to confirm, then stops that person's access, including any open chat. **Restore…** re-opens the dialog on a revoked person; saving grants access again and makes a new revision, without reviving their old sessions.

## Check access

A safe way to try a person against an order before a real customer does. Pick a person, enter the order's ownership details (id, version, owner account and any assigned accounts) and press **Preview**. The result is **Allow** or **Deny**.

- Nothing is saved, nothing is activated, and no order data is fetched.
- It uses the same policy path as a real protected read: the person's access level must agree with the order's ownership, and the policy engine can still refuse. An engine can narrow an answer but never widen it.
- **An order they own** and **Someone else's order** fill the form for the two most useful checks.
- It does **not** call your order API. To exercise the API, use **Test your order API** on the Setup tab and a real protected chat.

## Activity

The latest 50 events, newest first: sign-ins, order reads, saved and revoked access, connection changes and **denials**. Filter by **All**, **Allowed** or **Denied**; **Refresh** reloads.

Each row shows when it happened, the outcome, what happened in plain words with the raw code beneath it, the person (their sign-in subject; **Operator** for changes made on this page) and the conversation. Activity records codes and ids only, never an order's contents, a token or a secret.

Common reasons:

| Code | Reads as |
|------|----------|
| `admitted`, `oidc_verified` | Signed in |
| `order_read` | Order read |
| `permission_assigned` | Access saved |
| `connection_registered`, `connection_disabled` | Connection registered or disabled |
| `oidc_registered`, `oidc_activated` | OIDC draft registered, OIDC went live |
| `session_revoked`, `principal_revoked`, `grant_revoked`, `connection_revoked` | Revoked |

A reason the console does not know is shown as its raw code.

## Setup

The Setup tab is where a Host that manages identity itself is configured. There are three cards and a switch.

### Policy engine

Who decides, order by order, whether a person may read it.

| Choice | Behaviour |
|--------|-----------|
| **Built-in rules** (default) | Checks the access level against the order's owner and assignments. Nothing else to run |
| **Cerbos policy server** | Adds your own policy on top. It can narrow access and never widen it. The server must run on this machine; load `policy-samples/consumer-orders.yaml` (version `consumer_v1`) into it first |

**Save engine** applies the choice at once. **Test engine** checks that the engine allows an order the person owns and refuses someone else's, and tells you which of these happened:

- **Answered correctly**: all good.
- **Did not answer**: the address is wrong, the server is down or the policy is not loaded.
- **Allows too much**: it allowed an order the person does not own. Access levels still apply in front of it, but fix the policy.

If the engine cannot answer in a real chat, the read is denied. It never falls open.

### Order API

Where Stageflow checks who owns an order and reads its status. It is **optional**: without it, people can sign in and be mapped, but no private order is ever read.

To connect it, enter the **Address**, an **Audience** and an **API credential**, then press **Connect order API**. The address must be `https`. The credential is sent as a bearer token to this address only and is never shown again. Once connected, the card shows the address and audience and **Credential: Saved, never shown**, with **Edit settings…** (leave the credential empty to keep it) and **Remove…**.

The card also holds:

- **Signing key.** Stageflow signs every order read with a key the Host generated. The public half is shown as a JWKS with **Copy public key**; your API verifies the signature with it. The private half never leaves the Host. **Rotate key…** replaces it at once, so your API must trust the new key first.
- **Test your order API.** Enter a real order id and press **Run test**. Stageflow asks your API for that order's ownership details only and confirms its own signing key works. The result is either success with the order's version and the number of assigned accounts, or one of: save settings first, add a credential, rotate to create a key, or *no valid ownership reply came back* (check the address, the credential, that the order exists and that the reply matches the contract).
- **What your API must implement.** A collapsed summary of the two endpoints. The full contract is in [Order API contract](order-api-contract.md).

### Turn off

**Turn off identity…** (with a confirm) stops protected agent chats until you turn it on again. People, access and activity are kept.

## Errors

The console shows a short explanation and, beneath it, the code, so the code is always there for a support request.

| Code | Meaning and fix |
|------|-----------------|
| `identity.setup_required` | A field is missing or invalid, or identity is not set up on this Host. On the turn-on screen it means identity is off |
| `identity.conflict` | Someone else changed this person just now. Reload and try again |
| `identity.verification_required` | A test sign-in has to be recorded before OIDC can go live |
| `identity.not_available` | The item is gone |
| `identity.managed_externally` | The app that runs this Host manages identity; change it there |
| `invalid_jwks` | The pasted key set is not valid JWKS JSON |
| `request_failed` | The Host could not be reached |
| `http_401` | The Host needs its control token; sign in to the console again |

## Related

- [Protect an agent's chat with customer sign-in](guides-agents-protected-chat.md): the full setup, in order.
- [Order API contract](order-api-contract.md): what your order system implements.
- [Consumer identity](consumer-identity.md): the security model, the signed handoff, OIDC, delegation and the Host and embedder interfaces.
- [Web chat](guides-agents-web-chat.md) and [Agent definition](agent-definition.md#web_chat): `web_chat.access: authenticated`.
