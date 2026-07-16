# Collaborator invite keys

Invite keys let an external **REBUS Connector** user authenticate without a
portal/Google account. A key exchanges for the same `ConnectorManifest` shape
as portal login, with **project-scoped** access and an admin-chosen
`allowedFunctions` set.

There is **no separate Lite/Light binary**. Connector edition (send-only vs
send+receive UI) is driven entirely by the manifest ACL.

Contract source of truth: `src/contracts/portal-access.ts`
(`rebus/connector-manifest/v1`).

---

## Behaviour

1. An Orbit/PRISM admin creates a key bound to one or more `orbitProjectId`s,
   `allowedFunctions` (default Light/send-only set), optional label / expiry /
   `maxRedemptions`, and **model access** (`all` | `selected` | `authored`).
2. Admin copies the plaintext key (or redeem URL) to the collaborator.
3. Connector pastes the key → `POST /api/access/session` with
   `{ inviteKey }` → `{ manifest }`.
4. No separate Orbit login user is required. Sessions are attributed as
   `invite:<keyId>` in identity / audit fields.

### Model access modes

| Mode | Behaviour |
|------|-----------|
| `all` (default) | Every model in the key's granted projects |
| `selected` | Only models listed in `selectedModelIds` (required, non-empty) |
| `authored` | Only models whose Orbit property **`userId`** equals `manifest.userId` (`invite:<keyId>`) — i.e. models the guest uploaded with that author id baked in |

Orbit tokens remain **project**-scoped. Model filtering is enforced by the
connector using manifest fields (`modelAccess`, `selectedModelIds`,
`authoredProperty: "userId"`).

### Default functions (Light / send-only preset)

When `allowedFunctions` is omitted on create, the key gets:

| Default allow |
|---------------|
| `send`, `create_model`, `create_version`, `list_models`, `list_versions` |

Admins may grant **any** `ConnectorFunction`, including `receive`,
`use_library`, `use_infile`, `create_project`, and `list_projects`. A send-only
invite yields a Lite-like UX in the single connector binary. Grant panel
surfaces independently — or use `receive` alone (still unlocks Library / In
File for back-compat).

`orbitBlanketAccess` is **always `false`** for invite-key sessions.

### Function → connector UI mapping

| Capability flag | Derived from |
|-----------------|--------------|
| `canSend` | `Allows("send")` |
| `canReceive` | `Allows("receive")` |
| `canUseLibrary` | `Allows("use_library")` **or** `Allows("receive")` |
| `canUseInFile` | `Allows("use_infile")` **or** `Allows("receive")` |
| `canOpenOrbitLinks` | `authMethod != "invite_key"` |
| Auth methods shown | portal + invite (invite-only users simply use invite) |

Client hide/show is UX only. Orbit token ACL remains the real enforcement.

---

## Admin API (admin cookie)

### `POST /api/access/invite-keys`

```json
{
  "orbitProjectIds": ["mock-project-1"],
  "allowedFunctions": ["send", "create_model", "create_version", "list_models", "receive"],
  "orbitTarget": "dev",
  "label": "Acme collaborator",
  "expiresAt": "2026-12-31T00:00:00.000Z",
  "maxRedemptions": 10,
  "projectNames": { "mock-project-1": "Demo Project A" },
  "modelAccess": "selected",
  "selectedModelIds": ["model-abc", "model-def"]
}
```

Response (plaintext `key` shown **once**):

```json
{
  "id": "…",
  "key": "invite_…",
  "redeemUrl": "https://…/api/access/invite-login?key=invite_…",
  "expiresAt": null,
  "projects": [{ "orbitProjectId": "mock-project-1", "projectName": "Demo Project A" }],
  "allowedFunctions": ["send", "create_model", "create_version", "list_models", "receive"],
  "label": "Acme collaborator",
  "maxRedemptions": 10,
  "modelAccess": "selected",
  "selectedModelIds": ["model-abc", "model-def"]
}
```

### `PATCH /api/access/invite-keys/:id`

Partial update (label, projects, functions, expiry, redemptions, `modelAccess` /
`selectedModelIds`). Revoked keys cannot be edited.

### `GET /api/access/invite-keys`

Lists keys (no plaintext). Includes redemption counts and revoke status.

### `POST /api/access/invite-keys/:id/revoke`

Revokes the key **and** all outstanding `access_session` rows derived from it
(plus linked `minted_token` rows).

---

## Connector / public API

### `POST /api/access/session`

Accepts either portal OAuth **or** invite key:

```json
{ "inviteKey": "invite_…", "orbitTarget": "dev" }
```

or (after browser redeem):

```json
{ "portalAuthCode": "invite:invite_…", "redirectUri": "http://localhost:29364/" }
```

Manifest extras:

```json
{
  "authMethod": "invite_key",
  "inviteKeyId": "…",
  "orbitBlanketAccess": false,
  "userId": "invite:<keyId>",
  "modelAccess": "authored",
  "selectedModelIds": [],
  "authoredProperty": "userId",
  "globalAllowedFunctions": [],
  "projects": [
    {
      "orbitProjectId": "mock-project-1",
      "level": "contributor",
      "allowedFunctions": ["send", "create_model", "create_version", "list_models", "list_versions"]
    }
  ]
}
```

Connector responsibilities for model access:

1. **`all`** — list/open any model in granted projects.
2. **`selected`** — filter `list_models` / open to `selectedModelIds`.
3. **`authored`** — filter to models where property `userId` (or
   `properties.userId`) equals `manifest.userId`. On `create_model` /
   upload, bake `userId = manifest.userId` so later sessions see the guest's
   own models.

### `GET /api/access/manifest?sessionId=`

Returns the connector manifest for an active session.

For **invite-key** sessions, grant fields are rebuilt from the **live** invite key
row before returning (and the session row is updated). That means an admin
`PATCH` of `modelAccess` / `selectedModelIds` / projects / functions is visible
to the connector on the next model-list refresh **without** signing out.

Preserved across refresh: `sessionId`, `orbitToken`, `expiresAt`, `userId`,
`email`. `displayName` follows the current invite key label when set.

Portal sessions still return the stored snapshot.

### `GET /api/access/invite-login?key=…&redirect_uri=http://localhost:29364/`

Validates the key, then redirects to
`redirect_uri?code=invite:<key>` for the existing connector loopback exchange.

### Mock demo key

When `portal_adapter=mock` (prism-dev):

| Field | Value |
|-------|-------|
| Plaintext | `invite_demo_light_mock-project-1` |
| Project | `mock-project-1` |
| Id | `invite-demo-light` |

`GET /api/access/invite-keys/demo` echoes this for local connector testing.

---

## Enforcement

1. **Manifest** — client DenyIfNotAllowed / capability UI is UX only; invite
   keys never set `orbitBlanketAccess=true`. Grants are exactly the key's
   `allowedFunctions` (fail closed when empty/missing for invite sessions).
2. **Orbit token** — prefer `apiTokenCreate` with `limitResources` (needs
   `tokens:write` on `ORBIT_MINT_TOKEN` / `ORBIT_ADMIN_TOKEN`). Invite-key
   mints set `forbidAdminFallback: true` — a failed scoped mint **must not**
   fall back to a broad admin PAT.
3. **Model access** — connector filters `list_models` / open using
   `modelAccess` / `selectedModelIds` / `authoredProperty` (`userId`).
4. **Revocation** — key revoke marks sessions + minted tokens `revokedAt`.
5. **Audit** — `invite_key.created_by`, `invite_key_redemption` rows, session
   `invite_key_id`, manifest `userId` / `inviteKeyId`.

---

## Admin UI (PRISM monorepo)

Guest properties dialog exposes the full connector function set (Light preset
pre-checked) plus three model-access radios (all / selected / authored) and a
model selection tree when `selected`.

---

## Monorepo docs

Mirror this into PRISM monorepo `docs/PORTAL_CONTRACT.md` and `PERMISSIONS.md`
when those files are updated in the monorepo (polyrepo cannot push there).
