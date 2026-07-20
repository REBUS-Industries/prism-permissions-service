import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  GoogleWorkspaceLink,
  PortalAdapter,
  PortalProjectPermission,
  PortalProjectPermissionsSyncResult,
  PortalUser,
  ProvisionedAdminCheck,
  ProvisionedUser,
  ProvisionedUserInput,
  WorkspaceSyncResult,
} from '../contracts/portal-access.js';
import { getDb } from '../db/client.js';
import { googleWorkspace, provisionedUser } from '../db/schema.js';
import { getIntegrationSetting, getIntegrationSettingOr } from '../config/integrationSettings.js';
import { listMockWorkspaceDirectory } from './mockDirectory.js';
import { listGoogleWorkspaceDirectory } from './googleDirectory.js';

function projectsEqual(a: PortalProjectPermission[], b: PortalProjectPermission[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: PortalProjectPermission) =>
    `${p.orbitProjectId}\0${p.level}\0${p.projectName ?? ''}`;
  const left = [...a].map(key).sort();
  const right = [...b].map(key).sort();
  return left.every((v, i) => v === right[i]);
}

const WORKSPACE_ROW_ID = 'default';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function rowToWorkspace(row: typeof googleWorkspace.$inferSelect, userCount: number): GoogleWorkspaceLink {
  return {
    id: row.id,
    domain: row.domain,
    displayName: row.displayName,
    status: row.status as GoogleWorkspaceLink['status'],
    adapter: row.adapter,
    linkedAt: row.linkedAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    userCount,
  };
}

function rowToProvisionedUser(row: typeof provisionedUser.$inferSelect): ProvisionedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    googleSub: row.googleSub,
    status: row.status as ProvisionedUser['status'],
    source: row.source as ProvisionedUser['source'],
    isPrismAdmin: row.isPrismAdmin,
    prismAdminUsername: row.prismAdminUsername,
    projectPermissions: (row.projectPermissions ?? []) as PortalProjectPermission[],
    roleRefs: row.roleRefs ?? [],
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function countProvisionedUsers(workspaceId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(provisionedUser)
    .where(eq(provisionedUser.workspaceId, workspaceId));
  return rows[0]?.value ?? 0;
}

export async function getWorkspaceLink(): Promise<GoogleWorkspaceLink | null> {
  const db = getDb();
  const rows = await db.select().from(googleWorkspace).where(eq(googleWorkspace.id, WORKSPACE_ROW_ID)).limit(1);
  const row = rows[0];
  if (!row || row.status === 'disconnected') return null;
  const userCount = await countProvisionedUsers(row.id);
  return rowToWorkspace(row, userCount);
}

export async function linkGoogleWorkspace(domain: string, displayName?: string): Promise<GoogleWorkspaceLink> {
  const db = getDb();
  const now = new Date();
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain.includes('.')) {
    throw new Error('Enter a valid workspace domain (e.g. rebus.industries)');
  }

  const adapter = await getIntegrationSettingOr(
    'workspace_adapter',
    (await getIntegrationSettingOr('portal_adapter', 'mock')) === 'mock' ? 'mock' : 'google_admin_sdk',
  );
  const existing = await db.select().from(googleWorkspace).where(eq(googleWorkspace.id, WORKSPACE_ROW_ID)).limit(1);
  if (existing[0]) {
    await db
      .update(googleWorkspace)
      .set({
        domain: normalizedDomain,
        displayName: displayName ?? existing[0].displayName,
        status: 'linked',
        adapter,
        linkedAt: existing[0].linkedAt ?? now,
        updatedAt: now,
      })
      .where(eq(googleWorkspace.id, WORKSPACE_ROW_ID));
  } else {
    await db.insert(googleWorkspace).values({
      id: WORKSPACE_ROW_ID,
      domain: normalizedDomain,
      displayName: displayName ?? normalizedDomain,
      status: 'linked',
      adapter,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  const linked = await getWorkspaceLink();
  if (!linked) throw new Error('Failed to link workspace');
  return linked;
}

export async function unlinkGoogleWorkspace(): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(googleWorkspace)
    .set({ status: 'disconnected', updatedAt: now })
    .where(eq(googleWorkspace.id, WORKSPACE_ROW_ID));
}

export async function listProvisionedUsers(): Promise<ProvisionedUser[]> {
  const db = getDb();
  const rows = await db.select().from(provisionedUser).orderBy(provisionedUser.email);
  return rows.map(rowToProvisionedUser);
}

export async function findProvisionedUserByEmail(email: string): Promise<ProvisionedUser | null> {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const rows = await db
    .select()
    .from(provisionedUser)
    .where(eq(sql`lower(${provisionedUser.email})`, normalized))
    .limit(1);
  const row = rows[0];
  return row ? rowToProvisionedUser(row) : null;
}

export async function createProvisionedUser(input: ProvisionedUserInput): Promise<ProvisionedUser> {
  const workspace = await getWorkspaceLink();
  if (!workspace) throw new Error('Link a Google Workspace before provisioning users');

  const db = getDb();
  const now = new Date();
  const email = normalizeEmail(input.email);
  const id = randomUUID();

  await db.insert(provisionedUser).values({
    id,
    workspaceId: workspace.id,
    email,
    displayName: input.displayName ?? null,
    status: input.status ?? 'pending',
    source: 'manual',
    isPrismAdmin: input.isPrismAdmin ?? false,
    prismAdminUsername: input.prismAdminUsername ?? null,
    projectPermissions: input.projectPermissions ?? [],
    roleRefs: input.roleRefs ?? [],
    createdAt: now,
    updatedAt: now,
  });

  const created = await findProvisionedUserByEmail(email);
  if (!created) throw new Error('Failed to create provisioned user');
  return created;
}

export async function updateProvisionedUser(
  id: string,
  patch: Partial<ProvisionedUserInput>,
): Promise<ProvisionedUser | null> {
  const db = getDb();
  const now = new Date();
  const rows = await db.select().from(provisionedUser).where(eq(provisionedUser.id, id)).limit(1);
  if (!rows[0]) return null;

  const next: Partial<typeof provisionedUser.$inferInsert> = { updatedAt: now };
  if (patch.email !== undefined) next.email = normalizeEmail(patch.email);
  if (patch.displayName !== undefined) next.displayName = patch.displayName;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.isPrismAdmin !== undefined) next.isPrismAdmin = patch.isPrismAdmin;
  if (patch.prismAdminUsername !== undefined) next.prismAdminUsername = patch.prismAdminUsername;
  if (patch.projectPermissions !== undefined) next.projectPermissions = patch.projectPermissions;
  if (patch.roleRefs !== undefined) next.roleRefs = patch.roleRefs;

  await db.update(provisionedUser).set(next).where(eq(provisionedUser.id, id));

  const updated = await db.select().from(provisionedUser).where(eq(provisionedUser.id, id)).limit(1);
  return updated[0] ? rowToProvisionedUser(updated[0]) : null;
}

export async function deleteProvisionedUser(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.delete(provisionedUser).where(eq(provisionedUser.id, id)).returning({ id: provisionedUser.id });
  return rows.length > 0;
}

export async function syncWorkspaceDirectory(): Promise<WorkspaceSyncResult> {
  const db = getDb();
  const workspaceRow = await db.select().from(googleWorkspace).where(eq(googleWorkspace.id, WORKSPACE_ROW_ID)).limit(1);
  const row = workspaceRow[0];
  if (!row || row.status === 'disconnected') {
    throw new Error('Link a Google Workspace before syncing');
  }

  await db.update(googleWorkspace).set({ status: 'syncing', updatedAt: new Date() }).where(eq(googleWorkspace.id, row.id));

  const adapter = (row.adapter ?? (await getIntegrationSettingOr('workspace_adapter', 'mock'))).toLowerCase();
  const directory =
    adapter === 'google_admin_sdk'
      ? await listGoogleWorkspaceDirectory(row.domain)
      : listMockWorkspaceDirectory(row.domain);

  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  const now = new Date();

  for (const entry of directory) {
    const email = normalizeEmail(entry.email);
    const existing = await db
      .select()
      .from(provisionedUser)
      .where(eq(sql`lower(${provisionedUser.email})`, email))
      .limit(1);

    if (existing[0]) {
      const nextStatus =
        entry.suspended === true
          ? 'suspended'
          : existing[0].status === 'suspended'
            ? 'pending'
            : existing[0].status;
      const needsUpdate =
        existing[0].displayName !== entry.displayName ||
        (entry.googleSub && existing[0].googleSub !== entry.googleSub) ||
        nextStatus !== existing[0].status;
      if (needsUpdate) {
        await db
          .update(provisionedUser)
          .set({
            displayName: entry.displayName,
            googleSub: entry.googleSub ?? existing[0].googleSub,
            status: nextStatus as typeof provisionedUser.$inferInsert.status,
            updatedAt: now,
          })
          .where(eq(provisionedUser.id, existing[0].id));
        updated += 1;
      } else {
        unchanged += 1;
      }
      continue;
    }

    await db.insert(provisionedUser).values({
      id: randomUUID(),
      workspaceId: row.id,
      email,
      displayName: entry.displayName,
      googleSub: entry.googleSub ?? null,
      status: 'pending',
      source: 'workspace_sync',
      isPrismAdmin: false,
      projectPermissions: [],
      roleRefs: [],
      createdAt: now,
      updatedAt: now,
    });
    imported += 1;
  }

  await db
    .update(googleWorkspace)
    .set({ status: 'linked', lastSyncAt: now, updatedAt: now })
    .where(eq(googleWorkspace.id, row.id));

  const linked = await getWorkspaceLink();
  if (!linked) throw new Error('Workspace missing after sync');
  return { linked, imported, updated, unchanged };
}

export interface ResolvedProvisionedAccess {
  blocked: boolean;
  reason?: string;
  provisioned: ProvisionedUser | null;
  projects: PortalProjectPermission[];
  roleRefs: string[];
}

function enforceProvisionedOnly(): Promise<boolean> {
  return getIntegrationSettingOr('workspace_enforce_provisioned', '1').then((v) => v !== '0');
}

export async function resolveProvisionedAccess(
  portalUser: PortalUser,
  portalProjects: PortalProjectPermission[],
  opts?: { portalMembershipsSupported?: boolean },
): Promise<ResolvedProvisionedAccess> {
  const workspace = await getWorkspaceLink();
  const provisioned = await findProvisionedUserByEmail(portalUser.email);
  const portalMembershipsSupported = opts?.portalMembershipsSupported !== false;

  if (workspace && (await enforceProvisionedOnly())) {
    if (!provisioned) {
      return {
        blocked: true,
        reason: `${portalUser.email} is not provisioned in PRISM. Sync Google Workspace or add the user manually.`,
        provisioned: null,
        projects: [],
        roleRefs: [],
      };
    }
    if (provisioned.status === 'suspended') {
      return {
        blocked: true,
        reason: `${portalUser.email} is suspended in PRISM.`,
        provisioned,
        projects: [],
        roleRefs: [],
      };
    }
  }

  if (provisioned) {
    // Portal memberships are source of truth when the adapter supports them
    // (real/mock). Direct Google OAuth keeps manual provisioned assignments.
    return {
      blocked: false,
      provisioned,
      projects: portalMembershipsSupported ? portalProjects : provisioned.projectPermissions,
      roleRefs: provisioned.roleRefs,
    };
  }

  return {
    blocked: false,
    provisioned: null,
    projects: portalProjects,
    roleRefs: [],
  };
}

export async function recordProvisionedLogin(
  portalUser: PortalUser,
  opts?: {
    portalProjects?: PortalProjectPermission[];
    portalMembershipsSupported?: boolean;
  },
): Promise<void> {
  const provisioned = await findProvisionedUserByEmail(portalUser.email);
  if (!provisioned) return;

  const db = getDb();
  const now = new Date();
  const patch: Record<string, unknown> = {
    googleSub: portalUser.googleSub ?? provisioned.googleSub ?? null,
    displayName: portalUser.displayName ?? provisioned.displayName ?? null,
    status: provisioned.status === 'pending' ? 'active' : provisioned.status,
    lastLoginAt: now,
    updatedAt: now,
  };
  if (opts?.portalMembershipsSupported !== false && opts?.portalProjects) {
    patch.projectPermissions = opts.portalProjects;
  }
  await db
    .update(provisionedUser)
    .set(patch)
    .where(eq(provisionedUser.id, provisioned.id));
}

/**
 * Pull portal project memberships (bulk feed) and write them onto matching
 * provisioned users by email (full replace per user).
 */
export async function syncPortalProjectPermissions(
  portal: PortalAdapter,
): Promise<PortalProjectPermissionsSyncResult> {
  const domain = (await getIntegrationSetting('workspace_domain'))?.trim().toLowerCase() || undefined;
  let cursor: string | undefined;
  const byEmail = new Map<string, PortalProjectPermission[]>();
  let supported = true;

  for (let page = 0; page < 100; page += 1) {
    const batch = await portal.listAllProjectPermissions({
      cursor,
      limit: 200,
      domain,
    });
    if (!batch.supported) {
      supported = false;
      break;
    }
    for (const row of batch.users) {
      byEmail.set(row.email.trim().toLowerCase(), row.projects);
    }
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }

  if (!supported) {
    return { supported: false, updated: 0, unchanged: 0, unmatched: 0, cleared: 0 };
  }

  const provisioned = await listProvisionedUsers();
  const provisionedByEmail = new Map(provisioned.map((u) => [u.email.toLowerCase(), u]));
  let updated = 0;
  let unchanged = 0;
  let cleared = 0;
  let unmatched = 0;

  for (const [email, projects] of byEmail) {
    const user = provisionedByEmail.get(email);
    if (!user) {
      unmatched += 1;
      continue;
    }
    if (projectsEqual(user.projectPermissions, projects)) {
      unchanged += 1;
      continue;
    }
    await updateProvisionedUser(user.id, { projectPermissions: projects });
    updated += 1;
    if (projects.length === 0) cleared += 1;
  }

  // Users in Prism but absent from the portal feed keep existing rows —
  // the bulk endpoint may be domain-filtered. Login-time sync still refreshes them.

  return { supported: true, updated, unchanged, unmatched, cleared };
}

export async function checkProvisionedAdmin(email: string): Promise<ProvisionedAdminCheck> {
  const normalized = normalizeEmail(email);
  const provisioned = await findProvisionedUserByEmail(normalized);
  if (provisioned?.isPrismAdmin && provisioned.status !== 'suspended') {
    return {
      allowed: true,
      email: normalized,
      prismAdminUsername: provisioned.prismAdminUsername,
    };
  }
  return { allowed: false, email: normalized };
}
