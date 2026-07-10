# prism-permissions-service

Portal-brokered access + node-based connector permissions for PRISM/ORBIT.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/access/session` | — | Exchange portal OAuth code **or** invite key → `{ manifest }` |
| GET | `/api/access/invite-login` | — | Browser redeem → `redirect_uri?code=invite:…` |
| POST | `/api/access/invite-keys` | admin cookie | Create collaborator invite key |
| GET | `/api/access/invite-keys` | admin cookie | List invite keys |
| POST | `/api/access/invite-keys/:id/revoke` | admin cookie | Revoke key + derived sessions |
| GET | `/api/access/invite-keys/demo` | — | Echo seeded mock demo key (mock adapter) |
| POST | `/api/access/portal-user` | — | Validate portal OAuth code → `{ user }` (admin Google login) |
| GET | `/api/access/manifest?sessionId=` | — | Refresh manifest for session |
| GET | `/api/access/mock-login` | — | Dev mock portal redirect (mock adapter only) |
| GET | `/api/permissions/portal-roles` | admin cookie | Live portal role catalogue |
| GET/PUT | `/api/permissions/policy` | admin cookie | Node graph CRUD |
| GET/PUT | `/api/permissions/tool-grants` | admin cookie | Role-based PRISM tool grants |
| GET | `/api/permissions/workspace` | admin cookie | Workspace link + provisioned users |
| POST | `/api/permissions/workspace/link` | admin cookie | Link Google Workspace domain |
| POST | `/api/permissions/workspace/sync` | admin cookie | Import directory users |
| POST/PATCH/DELETE | `/api/permissions/workspace/users` | admin cookie | Manage provisioned users |
| GET | `/api/access/provisioned-admin?email=` | — | Admin login allow-check |
| GET | `/health` | — | Liveness |

Port **8771** · image `ghcr.io/rebus-industries/prism-permissions-service`

## Deploy (prod / VM 212)

`permissions-image` builds on GitHub-hosted runners, then deploys via the
`[self-hosted, prism-deploy]` runner over SSH (`prism-dev` alias → VM 212).
There is no separate prism-dev stack. Deploy builds the image on the VM (GHCR
pull is 403 for polyrepo packages) and pins `PRISM_PERMISSIONS_TAG` in
`/opt/prism/.env`.

## Environment

| Variable | Description |
|----------|-------------|
| `POSTGRES_URL` | Permissions DB (or shared prism DB) |
| `SESSION_SECRET` | Must match PRISM admin cookie secret |
| `PORTAL_ADAPTER` | `mock` (default) or `real` |
| `PORTAL_BASE_URL` | REBUS portal API base |
| `PORTAL_API_KEY` | Service-to-portal bearer |
| `ORBIT_SERVER_URL` | Prod ORBIT GraphQL |
| `ORBIT_DEV_SERVER_URL` | Dev ORBIT GraphQL |
| `ORBIT_ADMIN_TOKEN` | Admin PAT for token minting |
| `ORBIT_AUTO_INVITE` | `1` to invite missing ORBIT users |

## Mock login (dev)

```
GET /api/access/mock-login?redirect_uri=http://localhost:29364/&persona=alice
→ redirects with ?code=mock:alice

POST /api/access/session { "portalAuthCode": "mock:alice" }
```

## Invite keys (Connector Light)

See [docs/INVITE_KEYS.md](docs/INVITE_KEYS.md).

```
# Admin creates a key (admin cookie required)
POST /api/access/invite-keys
{ "orbitProjectIds": ["mock-project-1"], "orbitTarget": "dev" }

# Collaborator redeems
POST /api/access/session
{ "inviteKey": "invite_…", "orbitTarget": "dev" }

# Or browser loopback
GET /api/access/invite-login?key=invite_…&redirect_uri=http://localhost:29364/

# Seeded mock demo key
GET /api/access/invite-keys/demo
→ { "key": "invite_demo_light_mock-project-1", … }
```

## Docs

- [`docs/PORTAL_PRISM_INTEGRATION.md`](docs/PORTAL_PRISM_INTEGRATION.md) — portal dev handoff: OAuth, service API key, endpoints, acceptance tests
- [`docs/INVITE_KEYS.md`](docs/INVITE_KEYS.md) — collaborator invite keys for REBUS Connector Light

## Repo setup

Push this scaffold to `REBUS-Industries/prism-permissions-service` on branch `main`.
Set org secret `PRISM_DISPATCH_TOKEN` for deploy dispatch to the prism monorepo.
