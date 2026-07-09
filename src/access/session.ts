import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AccessSessionRequest, PortalProjectPermission } from '../contracts/portal-access.js';
import { CONNECTOR_FUNCTIONS } from '../contracts/portal-access.js';
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
import { getIntegrationSettingOr } from '../config/integrationSettings.js';
import {
  extractInviteKeyFromSessionRequest,
  lookupRedeemableInviteKey,
  recordInviteKeyRedemption,
} from './inviteKeys.js';
import { AccessError } from './errors.js';

export { AccessError };

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

/**
 * Blanket access: all provisioned portal users receive ORBIT connector access to
 * every project (no per-project list). Controlled from Admin → Permissions via the
 * `workspace_grant_all_projects` setting (default on). `ORBIT_BLANKET_ACCESS=0` is an
 * ops kill-switch. When blanket is off, project-scoped manifests come from PRISM Users;
 * users with no assignments still get blanket access so they are not locked out.
 */
export async function useBlanketOrbitAccess(provisionedProjects: PortalProjectPermission[]): Promise<boolean> {
  if (process.env.ORBIT_BLANKET_ACCESS === '0') {
    return provisionedProjects.length === 0;
  }
  let enabled = true;
  try {
    enabled = (await getIntegrationSettingOr('workspace_grant_all_projects', '1')) !== '0';
  } catch {
    // Settings DB unavailable — default to blanket on so users are not locked out.
    enabled = true;
  }
  if (!enabled) {
    return provisionedProjects.length === 0;
  }
  return true;
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
  inviteKeyId?: string | null;
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
    inviteKeyId: input.inviteKeyId ?? null,
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
  blanket: boolean;
  /** When set, mint scopes from these functions instead of level-derived ones. */
  fixedFunctions?: import('../contracts/portal-access.js').ConnectorFunction[];
  /** Invite keys must never receive the admin PAT fallback. */
  forbidAdminFallback?: boolean;
}): Promise<{ orbitToken: string; orbitUserId: string; scopes: string[]; projectIds: string[] } | null> {
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

  if (!orbitUser && process.env.ORBIT_AUTO_INVITE === '1' && !input.forbidAdminFallback) {
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
  const projectIds = input.blanket ? [] : input.projects.map((p) => p.orbitProjectId);
  const functions = input.fixedFunctions?.length
    ? input.fixedFunctions
    : input.blanket
      ? [...CONNECTOR_FUNCTIONS]
      : ([...new Set(graphFunctionsForProjects(input.projects))] as typeof CONNECTOR_FUNCTIONS);

  try {
    const minted = await mintScopedOrbitToken({
      target: input.orbitTarget,
      orbitUserId,
      email: input.portalUser.email,
      projectIds,
      functions,
      sessionId: input.sessionId,
      forbidAdminFallback: input.forbidAdminFallback,
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

/**
 * Collaborator invite-key session: no portal user, no blanket access.
 * Identity is attributed as invite:<keyId> for audit.
 */
export async function exchangeInviteKeySession(body: AccessSessionRequest & { inviteKey: string }) {
  const key = await lookupRedeemableInviteKey(body.inviteKey);
  const orbitTarget: OrbitTarget = body.orbitTarget ?? key.orbitTarget;
  if (body.orbitTarget && body.orbitTarget !== key.orbitTarget) {
    throw new AccessError(
      `Invite key is bound to orbitTarget=${key.orbitTarget}`,
      400,
    );
  }

  const projects: PortalProjectPermission[] = key.orbitProjectIds.map((orbitProjectId) => ({
    orbitProjectId,
    level: 'contributor' as const,
    projectName: key.projectNames[orbitProjectId] ?? null,
  }));

  const sessionId = randomUUID();
  const expiresAt = sessionExpiry();
  const orbitServerUrl = resolveOrbitServerUrl(orbitTarget);
  const syntheticUser = {
    userId: `invite:${key.id}`,
    email: `invite+${key.id}@invite.prism.local`,
    displayName: `Invite ${key.id.slice(0, 8)}`,
  };
  const orbitUserId = `invite:${key.id}`;

  const linkId = await upsertIdentityLink(syntheticUser, orbitUserId);
  await cacheProjectPermissions(orbitUserId, projects);

  const minted = await tryMintOrbitToken({
    orbitTarget,
    portalUser: syntheticUser,
    projects,
    sessionId,
    blanket: false,
    fixedFunctions: key.allowedFunctions,
    forbidAdminFallback: true,
  });

  const manifest = await buildConnectorManifest({
    sessionId,
    orbitTarget,
    orbitServerUrl,
    orbitToken: minted?.orbitToken ?? '',
    expiresAt,
    portalUser: syntheticUser,
    portalProjects: projects,
    roleRefs: [],
    orbitBlanketAccess: false,
    prismAccessToken: sessionId,
    fixedAllowedFunctions: key.allowedFunctions,
    authMethod: 'invite_key',
    inviteKeyId: key.id,
  });

  await persistAccessSession({
    sessionId,
    linkId,
    orbitTarget,
    manifest,
    expiresAt,
    inviteKeyId: key.id,
    mintRow: {
      orbitUserId: minted?.orbitUserId ?? orbitUserId,
      email: syntheticUser.email,
      projectIds: minted?.projectIds ?? projects.map((p) => p.orbitProjectId),
      scopes: minted?.scopes ?? [],
      tokenPrefix: minted?.orbitToken ? minted.orbitToken.slice(0, 8) : 'prism-only',
    },
  });

  await recordInviteKeyRedemption({
    inviteKeyId: key.id,
    sessionId,
    orbitTarget,
    clientMeta: { redirectUri: body.redirectUri ?? null, createdBy: key.createdBy },
  });

  return { manifest, effectiveFunctions: collectEffectiveFunctions(manifest) };
}

export async function exchangePortalSession(
  portal: PortalAdapter,
  body: AccessSessionRequest,
) {
  const inviteKeyPlain = extractInviteKeyFromSessionRequest(body);
  if (inviteKeyPlain) {
    return exchangeInviteKeySession({ ...body, inviteKey: inviteKeyPlain });
  }

  if (!body.portalAuthCode) {
    throw new AccessError('portalAuthCode or inviteKey required', 400);
  }

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
  const blanket = await useBlanketOrbitAccess(effectiveProjects);

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
    blanket,
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
    orbitBlanketAccess: blanket,
    prismAccessToken: sessionId,
    authMethod: 'portal',
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
      projectIds: minted?.projectIds ?? (blanket ? [] : effectiveProjects.map((p) => p.orbitProjectId)),
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
