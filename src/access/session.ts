import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AccessSessionRequest } from '../contracts/portal-access.js';
import { getDb } from '../db/client.js';
import {
  accessSession,
  identityLink,
  mintedToken,
  projectPermissionCache,
} from '../db/schema.js';
import { findOrbitUserByEmail, inviteOrbitUser } from '../orbit/client.js';
import { mintScopedOrbitToken } from '../orbit/mint.js';
import type { PortalAdapter } from '../portal/adapter.js';
import { buildConnectorManifest, collectEffectiveFunctions } from './manifest.js';
import { getOrbitCreds, type OrbitTarget } from '../orbit/client.js';

export class AccessError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export async function exchangePortalSession(
  portal: PortalAdapter,
  body: AccessSessionRequest,
) {
  const orbitTarget: OrbitTarget = body.orbitTarget ?? 'prod';
  const portalToken = await portal.exchangeAuthCode(body.portalAuthCode, body.redirectUri);
  const portalUser = await portal.getMe(portalToken);
  const permissions = await portal.getProjectPermissions(portalToken, portalUser.userId);

  const creds = getOrbitCreds(orbitTarget);
  let orbitUser = await findOrbitUserByEmail(creds, portalUser.email);
  if (!orbitUser && process.env.ORBIT_AUTO_INVITE === '1') {
    orbitUser = await inviteOrbitUser(
      creds,
      portalUser.email,
      portalUser.displayName ?? portalUser.email,
    );
  }
  const orbitUserId = orbitUser?.id ?? `portal:${portalUser.userId}`;
  if (!orbitUser && process.env.ORBIT_AUTO_INVITE !== '1') {
    throw new AccessError(
      `No ORBIT user for ${portalUser.email}. Set ORBIT_AUTO_INVITE=1 or invite manually.`,
      403,
    );
  }

  const db = getDb();
  const now = new Date();
  let link = await db
    .select()
    .from(identityLink)
    .where(eq(identityLink.portalUserId, portalUser.userId))
    .limit(1);
  const linkId = link[0]?.id ?? randomUUID();
  if (link[0]) {
    await db
      .update(identityLink)
      .set({
        email: portalUser.email,
        googleSub: portalUser.googleSub ?? null,
        orbitUserId: orbitUser?.id ?? orbitUserId,
        updatedAt: now,
      })
      .where(eq(identityLink.id, linkId));
  } else {
    await db.insert(identityLink).values({
      id: linkId,
      portalUserId: portalUser.userId,
      googleSub: portalUser.googleSub ?? null,
      email: portalUser.email,
      orbitUserId: orbitUserId,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const p of permissions.projects) {
    const cacheId = `${orbitUserId}:${p.orbitProjectId}`;
    await db
      .insert(projectPermissionCache)
      .values({
        id: cacheId,
        orbitUserId: orbitUser?.id ?? orbitUserId,
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

  const sessionId = randomUUID();
  const projectIds = permissions.projects.map((p) => p.orbitProjectId);
  const graphFunctions = permissions.projects.flatMap((p) => {
    const levelFns =
      p.level === 'owner' || p.level === 'admin'
        ? ['send', 'receive', 'list_projects', 'list_models', 'list_versions', 'create_project', 'create_model', 'create_version']
        : p.level === 'contributor'
          ? ['send', 'receive', 'list_projects', 'list_models', 'list_versions', 'create_version']
          : ['list_projects', 'list_models', 'list_versions', 'receive'];
    return levelFns;
  }) as import('../contracts/portal-access.js').ConnectorFunction[];

  const minted = await mintScopedOrbitToken({
    target: orbitTarget,
    orbitUserId,
    email: portalUser.email,
    projectIds,
    functions: [...new Set(graphFunctions)],
    sessionId,
  });

  const manifest = await buildConnectorManifest({
    sessionId,
    orbitTarget,
    orbitServerUrl: creds.url,
    orbitToken: minted.token,
    expiresAt: minted.expiresAt,
    portalUser,
    portalProjects: permissions.projects,
  });

  const mintRowId = randomUUID();
  await db.insert(mintedToken).values({
    id: mintRowId,
    sessionId,
    orbitUserId,
    email: portalUser.email,
    orbitTarget,
    projectIds,
    scopes: minted.scopes,
    tokenPrefix: minted.token.slice(0, 8),
    expiresAt: minted.expiresAt,
    createdAt: now,
  });

  await db.insert(accessSession).values({
    id: sessionId,
    identityLinkId: linkId,
    mintedTokenId: mintRowId,
    orbitTarget,
    manifest,
    expiresAt: minted.expiresAt,
    createdAt: now,
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
