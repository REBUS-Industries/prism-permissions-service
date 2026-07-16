# PRISM ↔ Portal integration spec

**Audience:** portal-app developers (`portal.rebus.industries`)  
**From:** PRISM / `prism-permissions-service` team  
**Status:** PRISM side is implemented and deployed; portal must complete the items below for admin Google login and portal-sourced permissions to work end-to-end.

---

## Overview

PRISM delegates identity and permissions to the REBUS portal when `portal_adapter=real`. In that mode:

- **Portal** owns Google OAuth, user identity, roles, ORBIT project membership, and (optionally) which PRISM tools each role may use.
- **PRISM** redirects the browser to the portal for login, exchanges the auth code server-side, and reads roles/permissions from portal APIs.
- **`prism-permissions-service`** is the broker: it calls portal APIs and resolves effective access for admin UI, connectors, and ORBIT token minting.

Production is currently configured with `portal_adapter=real`. Admin **Sign in with Google** sends users to the portal, but the portal does not redirect back to PRISM with an authorization code after login. That is the immediate blocker.

---

## Architecture

```
Browser                PRISM (prism-server)          prism-permissions          Portal
   │                          │                            │                    │
   │  Sign in with Google     │                            │                    │
   ├─────────────────────────►│                            │                    │
   │                          │  GET /oauth/authorize      │                    │
   │◄─────────────────────────┼────────────────────────────┼───────────────────►│
   │  (portal login + Google) │                            │                    │
   │                          │                            │                    │
   │  ◄── MUST redirect back with code ──────────────────────────────────────────│
   │                          │                            │                    │
   │  /admin/?portal_callback=1&code=…                     │                    │
   ├─────────────────────────►│  POST /api/access/portal-user                   │
   │                          ├───────────────────────────►│                    │
   │                          │                            │ POST /portal/oauth/token
   │                          │                            ├───────────────────►│
   │                          │                            │ GET /portal/me     │
   │                          │                            ├───────────────────►│
   │                          │◄───────────────────────────┤                    │
   │◄─────────────────────────┤  prism_admin cookie        │                    │
```

---

## 1. OAuth authorize — `GET /oauth/authorize`

PRISM starts admin login with:

```http
GET https://portal.rebus.industries/oauth/authorize
  ?redirect_uri=https://prism.rebus.industries/admin/?portal_callback=1
  &prompt=select_account
```

Connector login uses the same endpoint with a different `redirect_uri`, e.g. `http://localhost:29364/`.

### Required behaviour

1. **Unauthenticated user:** redirect to login, preserving the **full** original authorize URL (all query params, including `prompt`) in the return/`next` path.
2. **After successful login:** resume `/oauth/authorize` with the same query params.
3. **Authenticated user:** mint a **single-use authorization code** and redirect the browser to `redirect_uri` with the code appended.

### Redirect format (critical)

PRISM's admin SPA reads the code from the **query string** (`window.location.search`), **not** the URL hash.

Because the admin `redirect_uri` already contains a query string, append the code with **`&code=`**:

```
https://prism.rebus.industries/admin/?portal_callback=1&code=PORTAL_AUTH_CODE
```

| ✅ Correct | ❌ Wrong |
|-----------|---------|
| `…/admin/?portal_callback=1&code=abc` | `…/admin/?portal_callback=1#code=abc` (hash — SPA won't see it) |
| | `…/admin/?code=abc` (missing `portal_callback=1`) |
| | `…/admin/?portal_callback=1?code=abc` (second `?`) |

### Allowed redirect URIs (allowlist)

Register and accept these exactly (including trailing slash and query where shown):

| Client | `redirect_uri` |
|--------|------------------|
| PRISM admin (prod) | `https://prism.rebus.industries/admin/?portal_callback=1` |
| ORBIT connector (local dev) | `http://localhost:29364/` |
| Add staging/dev PRISM URLs as needed | e.g. `https://prism-dev.rebus.industries/admin/?portal_callback=1` |

### Known bug today

Unauthenticated requests currently redirect to:

```
/login?next=/oauth/authorize?redirect_uri=…
```

The `next` value drops `prompt=select_account` (and any future params). Preserve the **entire** authorize query string through the login flow.

---

## 2. Token exchange — `POST /portal/oauth/token`

PRISM exchanges the browser authorization code **server-side** (the code never goes to the browser after the redirect — PRISM's SPA sends it to `prism-server`, which calls `prism-permissions`, which calls the portal).

### Request

```http
POST /portal/oauth/token
Authorization: Bearer <portal_service_api_key>
Content-Type: application/json

{
  "code": "authorization_code_from_redirect",
  "redirectUri": "https://prism.rebus.industries/admin/?portal_callback=1",
  "grantType": "authorization_code"
}
```

### Response (200)

```json
{
  "accessToken": "portal_user_bearer_token"
}
```

`token` is also accepted as an alias for `accessToken`.

### Rules

- Authenticate with the **portal service API key** (`Authorization: Bearer …`). This is the same key PRISM stores as `portal_api_key` — **not** a PRISM `prism_…` key.
- Validate `redirectUri` matches **exactly** what was used in `/oauth/authorize` (including query string).
- Authorization codes must be **single-use** and **short-lived** (recommend ≤ 10 minutes).
- Return `401` with a clear error body on invalid/missing service key (today returns `{"error":"invalid service key"}` — endpoint exists, key just needs to be provisioned).

---

## 3. Service API key

PRISM needs a portal-issued **service API key** for all server-to-portal calls.

| PRISM setting | Value |
|---------------|-------|
| `portal_base_url` | `https://portal.rebus.industries` |
| `portal_api_key` | Portal service key (Bearer token) |
| `portal_adapter` | `real` |
| `portal_google_authorize_url` | `https://portal.rebus.industries/oauth/authorize` |

Configured in PRISM admin: **Settings → Portal access key**. The **Save & check connection** button calls `GET /portal/roles` through PRISM to verify the key works.

**Deliverable:** mint a service key in the portal admin and share it with the PRISM ops contact so they can paste it into PRISM Settings.

---

## 4. User identity — `GET /portal/me`

Called with the **user access token** returned from `/portal/oauth/token`.

### Request

```http
GET /portal/me
Authorization: Bearer <user_access_token>
Accept: application/json
```

### Response (200)

```json
{
  "userId": "portal-user-123",
  "email": "alice@rebus.industries",
  "googleSub": "google-oauth-sub-optional",
  "displayName": "Alice Example",
  "roleId": "staffnew",
  "roleIds": ["staffnew"]
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `userId` | yes | Stable portal user id |
| `email` | yes | Used to match ORBIT users and PRISM admin provisioning |
| `roleId` | recommended | Primary role **id** — canonical key for permission resolution |
| `roleIds` | recommended | All role ids the user holds; PRISM unions them for grant lookup |
| `role` | legacy | Deprecated; use `roleId` instead |
| `customRoleId` | legacy | Deprecated; use `roleId` / `roleIds` instead |

**Role id conventions:**

- Ids are **case-sensitive** and must match `GET /portal/roles` and PRISM tool-grant keys.
- Super-admin role id **must** be `super-admin` (PRISM grants all tools automatically for this id).

---

## 5. Role catalogue — `GET /portal/roles`

Called with the **portal service API key** (not a user token). PRISM proxies this at `GET /api/permissions/portal-roles` for the admin Tool access UI.

### Request

```http
GET /portal/roles
Authorization: Bearer <portal_service_api_key>
Accept: application/json
```

### Response (200)

```json
{
  "roles": [
    { "id": "super-admin", "name": "Super Admin", "system": true },
    { "id": "admin",       "name": "Admin",       "system": true },
    { "id": "staffnew",    "name": "Staff",       "system": false },
    { "id": "viewer",      "name": "Viewer",      "system": true }
  ]
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Canonical role id — matched against `PortalUser.roleId` / `roleIds` and tool-grant keys |
| `name` | no | Display label in PRISM admin UI |
| `system` | no | `true` for built-in portal roles |

### Deletion / rename

- **Delete role:** remove it from this list. Also push an updated tool-grant map to PRISM (see §7) so stale grants are cleared.
- **Rename role:** change `name`, keep a **stable `id`**. Changing `id` creates a new role from PRISM's perspective.

If not yet implemented, return **404** or **501** — PRISM degrades gracefully. For production, this endpoint should be live.

---

## 6. Project permissions — `GET /portal/users/:userId/project-permissions`

Called with the **user access token** (service-key auth is also acceptable if you prefer — confirm one model with PRISM team).

### Request

```http
GET /portal/users/portal-user-123/project-permissions
Authorization: Bearer <user_access_token>
Accept: application/json
```

### Response (200)

```json
{
  "projects": [
    {
      "orbitProjectId": "abc123",
      "level": "contributor",
      "projectName": "Demo Project"
    }
  ]
}
```

### Levels

`viewer` | `contributor` | `owner` | `admin`

This drives ORBIT connector project access when PRISM is not in blanket-access mode. Portal remains the source of truth for which ORBIT projects a user may access.

---

## 7. Push tool grants to PRISM (portal → PRISM)

The portal is the **authoring surface** for which PRISM admin tools each role may use. PRISM stores grants keyed by **role id**.

PRISM tools: `convert`, `visualiser`, `fixtures`, `materials`, `models`

### Request

```http
PUT https://prism.rebus.industries/api/permissions/tool-grants
X-API-Key: prism_<key_with_access:admin_scope>
Content-Type: application/json

{
  "grants": {
    "roles": {
      "super-admin": ["convert", "visualiser", "fixtures", "materials", "models"],
      "staffnew":    ["convert", "visualiser"],
      "viewer":      []
    },
    "users": {}
  }
}
```

This is a **full replace** of the role grant map. On role delete, send a PUT without that role key.

Role keys must match `GET /portal/roles` ids and `GET /portal/me` `roleId` / `roleIds`.

**When to push:**

- Role created, renamed, or deleted in portal
- Tool permissions changed in portal (e.g. Settings → Integrations → PRISM Access)
- On deploy / periodic sync if you maintain grants in portal DB

PRISM ops will provide an API key with `access:admin` scope for this call.

---

## 8. Acceptance tests

Run these in order. All must pass before declaring integration complete.

### 8.1 Admin OAuth round-trip

1. Open in a browser (incognito):
   ```
   https://prism.rebus.industries/api/admin/login/google/start
   ```
2. Complete Google login on the portal.
3. **Expected:** browser lands on:
   ```
   https://prism.rebus.industries/admin/?portal_callback=1&code=<code>
   ```
4. **Expected:** PRISM admin dashboard loads (user provisioned as PRISM admin).

### 8.2 Token exchange

```bash
curl -sS -X POST 'https://portal.rebus.industries/portal/oauth/token' \
  -H 'Authorization: Bearer <portal_service_api_key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "<code_from_redirect>",
    "redirectUri": "https://prism.rebus.industries/admin/?portal_callback=1",
    "grantType": "authorization_code"
  }'
```

**Expected:** `200` with `{ "accessToken": "…" }`

### 8.3 User identity

```bash
curl -sS 'https://portal.rebus.industries/portal/me' \
  -H 'Authorization: Bearer <user_access_token>'
```

**Expected:** `200` with `userId`, `email`, `roleId`, `roleIds`

### 8.4 Role catalogue

```bash
curl -sS 'https://portal.rebus.industries/portal/roles' \
  -H 'Authorization: Bearer <portal_service_api_key>'
```

**Expected:** `200` with `{ "roles": [ … ] }`

Also verifiable from PRISM: **Settings → Portal access key → Save & check connection** should report connected with a role count.

### 8.5 Connector OAuth (dev)

1. ORBIT connector opens PRISM login with `redirect_uri=http://localhost:29364/`.
2. Complete portal Google login.
3. **Expected:** browser redirects to `http://localhost:29364/?code=<code>` (or equivalent connector callback).

### 8.6 Tool grant push

```bash
curl -sS -X PUT 'https://prism.rebus.industries/api/permissions/tool-grants' \
  -H 'X-API-Key: prism_<access_admin_key>' \
  -H 'Content-Type: application/json' \
  -d '{"grants":{"roles":{"staffnew":["convert"]},"users":{}}}'
```

**Expected:** `200`; visible in PRISM admin → Permissions → Tool access.

---

## 9. PRISM-side reference (already implemented)

These exist today — no portal changes needed on the PRISM side:

| PRISM endpoint | Purpose |
|----------------|---------|
| `GET /api/admin/login/google/start` | Redirects browser to portal `/oauth/authorize` |
| `POST /api/admin/login/google` | Exchanges portal code → `prism_admin` cookie |
| `POST /api/access/portal-user` | Validates portal code, returns user (permissions service) |
| `POST /api/access/session` | Connector session exchange → ORBIT manifest |
| `GET /api/permissions/portal-roles` | Proxies `GET /portal/roles` for admin UI |
| `GET/PUT /api/permissions/tool-grants` | Read/write role → tool grants |

Canonical TypeScript types: `shared/contracts/portal-access.ts` in the [PRISM monorepo](https://github.com/REBUS-Industries/prism) (`PortalUser`, `PortalRole`, `PortalRolesResponse`, `ToolGrants`).

---

## 10. Deliverables checklist

| # | Deliverable | Priority |
|---|-------------|----------|
| 1 | `/oauth/authorize` redirects back to PRISM with `&code=` after Google login | **P0 — blocks all login** |
| 2 | `/portal/oauth/token` accepts service key + code + redirectUri | **P0** |
| 3 | Mint portal service API key; share with PRISM ops | **P0** |
| 4 | `/portal/me` returns `roleId` + `roleIds` | **P1 — permissions resolution** |
| 5 | `/portal/roles` returns live role catalogue | **P1 — Tool access UI** |
| 6 | `/portal/users/:id/project-permissions` | **P1 — ORBIT project scoping** |
| 7 | Push tool grants to PRISM `PUT /api/permissions/tool-grants` | **P2 — portal-authored permissions** |
| 8 | Allowlist PRISM redirect URIs (admin + connector) | **P0** |

---

## 11. Contacts / open questions

- **PRISM ops:** configure `portal_api_key`, `portal_base_url`, keep `portal_adapter=real` in the shared `settings` table (DB overrides env vars).
- **PRISM API key for grant push:** request a `prism_…` key with `access:admin` scope from PRISM admin → API keys.
- **Open:** confirm whether `GET /portal/users/:id/project-permissions` accepts service key, user token, or both.

---

## Appendix: current production state (2026-06-26)

| Check | Result |
|-------|--------|
| PRISM adapter | `real` (`GET /api/access/health` → `"adapter":"real"`) |
| PRISM redirect to portal | ✅ Working |
| Portal redirect back to PRISM | ❌ Not happening after Google login |
| `POST /portal/oauth/token` | ⚠️ Reachable; returns `401 invalid service key` without valid key |
| Direct Google OAuth (`portal_adapter=google`) | ✅ Works as interim workaround; bypasses portal for login only — permissions would not come from portal |

---

## Appendix B: Collaborator invite keys

External connector users can authenticate with an **invite key** instead of
Google/portal OAuth. See [INVITE_KEYS.md](./INVITE_KEYS.md) for the full
contract.

There is no separate Lite connector binary — UI edition is driven by
`projects[].allowedFunctions` on the shared `ConnectorManifest`.

Summary for portal/connector teams:

- Admin: `POST/GET /api/access/invite-keys`, `PATCH/revoke` — any
  `ConnectorFunction` may be granted (default preset = Light/send-only)
- Connector: `POST /api/access/session` with `{ inviteKey }` (or
  `portalAuthCode: "invite:…"`)
- Manifest always has `orbitBlanketAccess: false`, `authMethod: "invite_key"`,
  and project-scoped `allowedFunctions` from the key
- Function → UI: `receive` → Receive; `use_library` / `use_infile` → Library /
  In File (`receive` still unlocks both for back-compat); invite sessions hide
  "Open in ORBIT" links (`canOpenOrbitLinks=false`)
- Mock demo key: `invite_demo_light_mock-project-1` → `mock-project-1`
