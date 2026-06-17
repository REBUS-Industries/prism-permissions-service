import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const identityLink = pgTable(
  'identity_link',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id').notNull(),
    googleSub: text('google_sub'),
    email: text('email').notNull(),
    orbitUserId: text('orbit_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('identity_link_portal_user_idx').on(t.portalUserId),
    index('identity_link_email_idx').on(t.email),
  ],
);

export const projectPermissionCache = pgTable(
  'project_permission_cache',
  {
    id: text('id').primaryKey(),
    orbitUserId: text('orbit_user_id').notNull(),
    orbitProjectId: text('orbit_project_id').notNull(),
    level: text('level').notNull(),
    projectName: text('project_name'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('project_perm_user_project_idx').on(t.orbitUserId, t.orbitProjectId),
    index('project_perm_user_idx').on(t.orbitUserId),
  ],
);

export const functionPolicyNodes = pgTable('function_policy_nodes', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  label: text('label').notNull(),
  ref: text('ref'),
  positionX: text('position_x').notNull(),
  positionY: text('position_y').notNull(),
  data: jsonb('data'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const functionPolicyEdges = pgTable('function_policy_edges', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull(),
  targetId: text('target_id').notNull(),
  grant: boolean('grant').default(true).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const mintedToken = pgTable(
  'minted_token',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    orbitUserId: text('orbit_user_id').notNull(),
    email: text('email').notNull(),
    orbitTarget: text('orbit_target').notNull(),
    projectIds: jsonb('project_ids').$type<string[]>().notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('minted_token_session_idx').on(t.sessionId)],
);

export const accessSession = pgTable(
  'access_session',
  {
    id: text('id').primaryKey(),
    identityLinkId: text('identity_link_id').notNull(),
    mintedTokenId: text('minted_token_id').notNull(),
    orbitTarget: text('orbit_target').notNull(),
    manifest: jsonb('manifest').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('access_session_identity_idx').on(t.identityLinkId)],
);

export const policySettings = pgTable('policy_settings', {
  id: text('id').primaryKey().default('default'),
  defaultFunctions: jsonb('default_functions').$type<string[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const toolGrant = pgTable(
  'tool_grant',
  {
    id: text('id').primaryKey(),
    principalType: text('principal_type').notNull(),
    principalRef: text('principal_ref').notNull(),
    tool: text('tool').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('tool_grant_principal_tool_idx').on(t.principalType, t.principalRef, t.tool),
    index('tool_grant_principal_idx').on(t.principalType, t.principalRef),
  ],
);

export const googleWorkspace = pgTable(
  'google_workspace',
  {
    id: text('id').primaryKey(),
    domain: text('domain').notNull(),
    displayName: text('display_name'),
    status: text('status').notNull().default('disconnected'),
    adapter: text('adapter').notNull().default('mock'),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('google_workspace_domain_idx').on(t.domain)],
);

export const provisionedUser = pgTable(
  'provisioned_user',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => googleWorkspace.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    googleSub: text('google_sub'),
    status: text('status').notNull().default('pending'),
    source: text('source').notNull().default('manual'),
    isPrismAdmin: boolean('is_prism_admin').notNull().default(false),
    prismAdminUsername: text('prism_admin_username'),
    projectPermissions: jsonb('project_permissions')
      .$type<
        {
          orbitProjectId: string;
          level: string;
          projectName?: string | null;
        }[]
      >()
      .notNull()
      .default([]),
    roleRefs: jsonb('role_refs').$type<string[]>().notNull().default([]),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('provisioned_user_workspace_idx').on(t.workspaceId),
    uniqueIndex('provisioned_user_email_idx').on(t.email),
  ],
);
