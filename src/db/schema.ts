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
