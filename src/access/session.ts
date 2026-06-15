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
import { findOrbitUserByEmail, inviteOrbitUser, OrbitClientError } from '../orbit/client.js';
import { mintScopedOrbitToken } from '../orbit/mint.js';
import type { PortalAdapter } from '../portal/adapter.js';
import { buildConnectorManifest, collectEffectiveFunctions } from './manifest.js';
import { getOrbitCreds, type OrbitTarget } from '../orbit/client.js';
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
  if (err instanceof OrbitClientError) {
    return new AccessError(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
  }
  if (err instanceof Error) {
    const message = err.message.trim() || fallback;
    if (/invalid_grant/i.test(message)) {
      return new AccessError(
        'Google OAuth code invalid or expired. Ensure redirectUri matches the connector callback (http://localhost:29364/).',
        401,
      );
    }
    if (/ORBIT admin credentials missing/i.test(message)) {
      return new AccessError(message, 503);
    }
    return new AccessError(message, status);
  }
  return new AccessError(fallback, status);
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

  let creds;
  try {
    creds = getOrbitCreds(orbitTarget);
  } catch (err) {
    throw toAccessError(
      err,
      `ORBIT admin credentials missing for target=${orbitTarget}. Set ORBIT_ADMIN_TOKEN / ORBIT_DEV_ADMIN_TOKEN on prism-permissions.`,
      503,
    );
  }

  let orbitUser = null;
  try {
    orbitUser = await findOrbitUserByEmail(creds, portalUser.email);
  } catch (err) {
    throw toAccessError(
      err,
      'ORBIT user lookup failed — verify ORBIT_ADMIN_TOKEN and ORBIT_DEV_ADMIN_TOKEN on prism-permissions.',
      502,
    );
  }
  if (!orbitUser && process.env.ORBIT_AUTO_INVITE === '1') {
    try {
      orbitUser = await inviteOrbitUser(
        creds,
        portalUser.email,
        portalUser.displayName ?? portalUser.email,
      );
    } catch {
      // Invite may fail (missing users:invite scope) — fall through to synthetic id + admin-token mint.
    }
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

  for (const p of effectiveProjects) {
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
  const projectIds = effectiveProjects.map((p) => p.orbitProjectId);
  const graphFunctions = effectiveProjects.flatMap((p) => {
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
    portalProjects: effectiveProjects,
    roleRefs,
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
