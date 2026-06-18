# prism-permissions-service

Portal-brokered access + node-based connector permissions for PRISM/ORBIT.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/access/session` | — | Exchange portal OAuth code → `{ manifest }` |
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

## Repo setup

Push this scaffold to `REBUS-Industries/prism-permissions-service` on branch `main`.
Set org secret `PRISM_DISPATCH_TOKEN` for deploy dispatch to the prism monorepo.
