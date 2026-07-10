# Diff notes for monorepo files (apply manually)

## `web/src/admin/utils/policyGraphLayout.ts`

Add to `GuestInviteNodeMeta`:

```ts
import type { ConnectorFunction, InviteModelAccess, PolicyNodeType } from '../../shared/api';

// inside GuestInviteNodeMeta:
  modelAccess?: InviteModelAccess;
  selectedModelIds?: string[];
```

## `web/src/shared/api.ts`

Add after `LIGHT_CONNECTOR_FUNCTIONS`:

```ts
export type InviteModelAccess = 'all' | 'selected' | 'authored';
```

Add to `CreateInviteKeyRequest`, `InviteKeyRecord`, `CreateInviteKeyResponse`, `UpdateInviteKeyRequest`:

```ts
  modelAccess?: InviteModelAccess;
  selectedModelIds?: string[] | null; // request; string[] on records
```

## `web/src/admin/pages/Permissions.vue`

- `guestMetaFromKey`: set `modelAccess` / `selectedModelIds` from key
- draft guest: `modelAccess: 'all'`, `selectedModelIds: []`
- `createInviteKey` / `updateInviteKey`: pass `modelAccess` + `selectedModelIds`
