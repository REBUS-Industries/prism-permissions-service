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
   `maxRedemptions`.
2. Admin copies the plaintext key (or redeem URL) to the collaborator.
3. Connector Light pastes the key → `POST /api/access/session` with
   `{ inviteKey }` → `{ manifest }`.
4. No separate Orbit login user is required. Sessions are attributed as
   `invite:<keyId>` in identity / audit fields.

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
  "projectNames": { "mock-project-1": "Demo Project A" }
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
  "maxRedemptions": 10
}
```

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
2. **Orbit token** — minted via `apiTokenCreate` as the mint/admin PAT's
   user, with `limitResources` = key project ids and scopes from allowed
   functions. The minting PAT (`ORBIT_MINT_TOKEN` or `ORBIT_ADMIN_TOKEN`)
   **must** include the `tokens:write` scope. Synthetic `invite:<id>` /
   `portal:<id>` user ids are never sent to Orbit. Mint failure returns
   **503** instead of an empty token.
3. **Revocation** — key revoke marks sessions + minted tokens `revokedAt`.
4. **Audit** — `invite_key.created_by`, `invite_key_redemption` rows, session
   `invite_key_id`, manifest `userId` / `inviteKeyId`.

---

## Monorepo docs

Mirror this into PRISM monorepo `docs/PORTAL_CONTRACT.md` and `PERMISSIONS.md`
when those files are updated in the monorepo (polyrepo cannot push there).
