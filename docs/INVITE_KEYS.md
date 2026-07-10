# Collaborator invite keys (Connector Light)

Invite keys let an external **REBUS Connector Light** (Rhino) user authenticate
without a portal/Google account. A key exchanges for the same
`ConnectorManifest` shape as portal login, with **project-scoped** access and
**upload-only** functions.

Contract source of truth: `src/contracts/portal-access.ts`
(`rebus/connector-manifest/v1`).

---

## Behaviour

1. An Orbit/PRISM admin creates a key bound to one or more `orbitProjectId`s,
   `allowedFunctions` (default Light set), optional label / expiry /
   `maxRedemptions`, and **model access** (`all` | `selected` | `authored`).
2. Admin copies the plaintext key (or redeem URL) to the collaborator.
3. Connector Light pastes the key → `POST /api/access/session` with
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

### Light default functions

| Allow | Deny |
|-------|------|
| `send`, `create_model`, `create_version`, `list_models`, `list_versions` | `receive`, `create_project` |

`orbitBlanketAccess` is **always `false`** for invite-key sessions.

---

## Admin API (admin cookie)

### `POST /api/access/invite-keys`

```json
{
  "orbitProjectIds": ["mock-project-1"],
  "allowedFunctions": ["send", "create_model", "create_version", "list_models"],
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
  "allowedFunctions": ["send", "create_model", "create_version", "list_models"],
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

1. **Manifest** — client DenyIfNotAllowed is UX only; invite keys never set
   `orbitBlanketAccess=true` and never include `receive` / `create_project`.
2. **Orbit token** — prefer `apiTokenCreate` with `limitResources` (needs
   `tokens:write` on `ORBIT_MINT_TOKEN` / `ORBIT_ADMIN_TOKEN`). If minting is
   unavailable, reuse PRISM's existing Orbit PAT — the same fallback portal
   sessions already use. Manifest still lists only the key's projects and
   Light functions for the connector.
3. **Model access** — connector filters `list_models` / open using
   `modelAccess` / `selectedModelIds` / `authoredProperty` (`userId`).
4. **Revocation** — key revoke marks sessions + minted tokens `revokedAt`.
5. **Audit** — `invite_key.created_by`, `invite_key_redemption` rows, session
   `invite_key_id`, manifest `userId` / `inviteKeyId`.

---

## Admin UI (PRISM monorepo)

Guest properties dialog should expose three radios (all / selected / authored)
and a model selection tree when `selected`. Apply the scaffold under
`docs/scaffolds/guest-model-access/` in the PRISM monorepo (this polyrepo
cannot push there).

---

## Monorepo docs

Mirror this into PRISM monorepo `docs/PORTAL_CONTRACT.md` and `PERMISSIONS.md`
when those files are updated in the monorepo (polyrepo cannot push there).
