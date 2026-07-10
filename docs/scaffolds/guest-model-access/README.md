# Guest model access — PRISM admin UI scaffold

Apply these files into the PRISM monorepo (`REBUS-Industries/prism`). This
polyrepo cannot push there.

## Authored property

Orbit model property for authored-only filtering: **`userId`**

Compare `model.userId` / `model.properties.userId` to `manifest.userId`
(`invite:<keyId>`). On upload, Connector Light should bake `userId =
manifest.userId`.

## Files

| Scaffold path | Monorepo destination |
|---------------|----------------------|
| `web/src/admin/components/permissions/ModelAccessTree.vue` | same (new) |
| `web/src/admin/components/permissions/GuestPropertiesDialog.vue` | merge / replace |
| `web/src/admin/utils/policyGraphLayout.ts` | add fields to `GuestInviteNodeMeta` |
| `web/src/shared/api.ts` | add `InviteModelAccess` + fields on invite types |
| `web/src/admin/pages/Permissions.vue` | wire create/update/load |

## Behaviour

Guest properties dialog radios:

1. **All models** (`modelAccess: 'all'`)
2. **Selected models** (`modelAccess: 'selected'`) — shows `ModelAccessTree`
3. **Models authored by this guest** (`modelAccess: 'authored'`) — filter by `userId`
