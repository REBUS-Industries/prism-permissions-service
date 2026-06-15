import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AccessSessionRequest, PortalProjectPermission } from '../contracts/portal-access.js';
import { getDb } from '../db/client.js';
import {
  accessSession,
  identityLink,
  mintedToken,
  projectPermissionCache,
} from '../db/schema.js';
import {
  findOrbitUserByEmail,
  getOrbitCreds,
  inviteOrbitUser,
  resolveOrbitServerUrl,
  type OrbitTarget,
} from '../orbit/client.js';
import { mintScopedOrbitToken } from '../orbit/mint.js';
import type { PortalAdapter } from '../portal/adapter.js';
import { buildConnectorManifest, collectEffectiveFunctions } from './manifest.js';
import { resolveProvisionedAccess, recordProvisionedLogin } from '../workspace/service.js';

export class AccessError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

function toAccessError(err: unknown, fallback: string, status = 500): AccessError {
  if (err instanceof AccessError) return err;
  if (err instanceof Error) {
    const message = err.message.trim() || fallback;
    if (/invalid_grant/i.test(message)) {
      return new AccessError(
        'Google OAuth code invalid or expired. Ensure redirectUri matches the connector callback (http://localhost:29364/).',
        401,
      );
    }
    return new AccessError(message, status);
  }
  return new AccessError(fallback, status);
}

export function shouldProvisionOrbit(projects: PortalProjectPermission[]): boolean {
  return projects.length > 0;
}

export function sessionExpiry(): Date {
  const lifespan = Number(process.env.ORBIT_TOKEN_LIFESPAN_SEC ?? 86400);
  return new Date(Date.now() + lifespan * 1000);
}

async function upsertIdentityLink(
  portalUser: { userId: string; email: string; googleSub?: string | null },
  orbitUserId: string,
) {
  const db = getDb();
  const now = new Date();
  const existing = await db
    .select()
    .from(identityLink)
    .where(eq(identityLink.portalUserId, portalUser.userId))
    .limit(1);
  const linkId = existing[0]?.id ?? randomUUID();

  if (existing[0]) {
    await db
      .update(identityLink)
      .set({
        email: portalUser.email,
        googleSub: portalUser.googleSub ?? null,
        orbitUserId,
        updatedAt: now,
      })
      .where(eq(identityLink.id, linkId));
  } else {
    await db.insert(identityLink).values({
      id: linkId,
      portalUserId: portalUser.userId,
      googleSub: portalUser.googleSub ?? null,
      email: portalUser.email,
      orbitUserId,
      createdAt: now,
      updatedAt: now,
    });
  }

  return linkId;
}

async function cacheProjectPermissions(
  orbitUserId: string,
  projects: PortalProjectPermission[],
) {
  const db = getDb();
  const now = new Date();
  for (const p of projects) {
    const cacheId = `${orbitUserId}:${p.orbitProjectId}`;
    await db
      .insert(projectPermissionCache)
      .values({
        id: cacheId,
        orbitUserId,
        orbitProjectId: p.orbitProjectId,
        level: p.level,
        projectName: p.projectName ?? null,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: projectPermissionCache.id,
        set: {
          level: p.level,
          projectName: p.projectName ?? null,
          fetchedAt: now,
        },
      });
  }
}

async function persistAccessSession(input: {
  sessionId: string;
  linkId: string;
  orbitTarget: OrbitTarget;
  manifest: Awaited<ReturnType<typeof buildConnectorManifest>>;
  expiresAt: Date;
  mintRow: {
    orbitUserId: string;
    email: string;
    projectIds: string[];
    scopes: string[];
    tokenPrefix: string;
  };
}) {
  const db = getDb();
  const now = new Date();
  const mintRowId = randomUUID();

  await db.insert(mintedToken).values({
    id: mintRowId,
    sessionId: input.sessionId,
    orbitUserId: input.mintRow.orbitUserId,
    email: input.mintRow.email,
    orbitTarget: input.orbitTarget,
    projectIds: input.mintRow.projectIds,
    scopes: input.mintRow.scopes,
    tokenPrefix: input.mintRow.tokenPrefix,
    expiresAt: input.expiresAt,
    createdAt: now,
  });

  await db.insert(accessSession).values({
    id: input.sessionId,
    identityLinkId: input.linkId,
    mintedTokenId: mintRowId,
    orbitTarget: input.orbitTarget,
    manifest: input.manifest,
    expiresAt: input.expiresAt,
    createdAt: now,
  });
}

function graphFunctionsForProjects(projects: PortalProjectPermission[]) {
  return projects.flatMap((p) => {
    const levelFns =
      p.level === 'owner' || p.level === 'admin'
        ? ['send', 'receive', 'list_projects', 'list_models', 'list_versions', 'create_project', 'create_model', 'create_version']
        : p.level === 'contributor'
          ? ['send', 'receive', 'list_projects', 'list_models', 'list_versions', 'create_version']
          : ['list_projects', 'list_models', 'list_versions', 'receive'];
    return levelFns;
  }) as import('../contracts/portal-access.js').ConnectorFunction[];
}

async function tryMintOrbitToken(input: {
  orbitTarget: OrbitTarget;
  portalUser: { userId: string; email: string; displayName?: string | null };
  projects: PortalProjectPermission[];
  sessionId: string;
}): Promise<{ orbitToken: string; orbitUserId: string; scopes: string[]; projectIds: string[] } | null> {
  if (!shouldProvisionOrbit(input.projects)) return null;

  let creds;
  try {
    creds = getOrbitCreds(input.orbitTarget);
  } catch {
    return null;
  }

  let orbitUser = null;
  try {
    orbitUser = await findOrbitUserByEmail(creds, input.portalUser.email);
  } catch {
    // ORBIT lookup is best-effort — PRISM login must still succeed.
  }

  if (!orbitUser && process.env.ORBIT_AUTO_INVITE === '1') {
    try {
      orbitUser = await inviteOrbitUser(
        creds,
        input.portalUser.email,
        input.portalUser.displayName ?? input.portalUser.email,
      );
    } catch {
      // Invite may fail (missing users:invite scope).
    }
  }

  const orbitUserId = orbitUser?.id ?? `portal:${input.portalUser.userId}`;
  const projectIds = input.projects.map((p) => p.orbitProjectId);
  const functions = [...new Set(graphFunctionsForProjects(input.projects))];

  try {
    const minted = await mintScopedOrbitToken({
      target: input.orbitTarget,
      orbitUserId,
      email: input.portalUser.email,
      projectIds,
      functions,
      sessionId: input.sessionId,
    });
    return {
      orbitToken: minted.token,
      orbitUserId,
      scopes: minted.scopes,
      projectIds,
    };
  } catch {
    return null;
  }
}

export async function exchangePortalSession(
  portal: PortalAdapter,
  body: AccessSessionRequest,
) {
  const orbitTarget: OrbitTarget = body.orbitTarget ?? 'prod';
  let portalToken: string;
  try {
    portalToken = await portal.exchangeAuthCode(body.portalAuthCode, body.redirectUri);
  } catch (err) {
    throw toAccessError(err, 'Portal OAuth exchange failed', 401);
  }

  const portalUser = await portal.getMe(portalToken);
  const permissions = await portal.getProjectPermissions(portalToken, portalUser.userId);
  const access = await resolveProvisionedAccess(portalUser, permissions.projects);
  if (access.blocked) {
    throw new AccessError(access.reason ?? 'Access denied', 403);
  }

  await recordProvisionedLogin(portalUser);
  const effectiveProjects = access.projects;
  const roleRefs = access.roleRefs;

  const sessionId = randomUUID();
  const expiresAt = sessionExpiry();
  const orbitServerUrl = resolveOrbitServerUrl(orbitTarget);
  const orbitUserId = `portal:${portalUser.userId}`;

  const linkId = await upsertIdentityLink(portalUser, orbitUserId);
  if (effectiveProjects.length > 0) {
    await cacheProjectPermissions(orbitUserId, effectiveProjects);
  }

  const minted = await tryMintOrbitToken({
    orbitTarget,
    portalUser,
    projects: effectiveProjects,
    sessionId,
  });

  const manifest = await buildConnectorManifest({
    sessionId,
    orbitTarget,
    orbitServerUrl,
    orbitToken: minted?.orbitToken ?? '',
    expiresAt,
    portalUser,
    portalProjects: effectiveProjects,
    roleRefs,
    orbitFunctionsEnabled: Boolean(minted?.orbitToken),
    prismAccessToken: sessionId,
  });

  await persistAccessSession({
    sessionId,
    linkId,
    orbitTarget,
    manifest,
    expiresAt,
    mintRow: {
      orbitUserId: minted?.orbitUserId ?? orbitUserId,
      email: portalUser.email,
      projectIds: minted?.projectIds ?? effectiveProjects.map((p) => p.orbitProjectId),
      scopes: minted?.scopes ?? [],
      tokenPrefix: minted?.orbitToken ? minted.orbitToken.slice(0, 8) : 'prism-only',
    },
  });

  return { manifest, effectiveFunctions: collectEffectiveFunctions(manifest) };
}

export async function getSessionManifest(sessionId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(accessSession)
    .where(eq(accessSession.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) throw new AccessError('Session not found', 404);
  if (row.expiresAt < new Date()) throw new AccessError('Session expired', 401);
  return row.manifest as import('../contracts/portal-access.js').ConnectorManifest;
}

export async function revokeSession(sessionId: string) {
  const db = getDb();
  const now = new Date();
  await db
    .update(accessSession)
    .set({ revokedAt: now })
    .where(eq(accessSession.id, sessionId));
  const sessions = await db
    .select()
    .from(accessSession)
    .where(eq(accessSession.id, sessionId))
    .limit(1);
  const mintId = sessions[0]?.mintedTokenId;
  if (mintId) {
    await db.update(mintedToken).set({ revokedAt: now }).where(eq(mintedToken.id, mintId));
  }
}
