import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  CONNECTOR_FUNCTIONS,
  INVITE_KEY_DENIED_FUNCTIONS,
  LIGHT_CONNECTOR_FUNCTIONS,
  type ConnectorFunction,
  type CreateInviteKeyRequest,
  type CreateInviteKeyResponse,
  type InviteKeyProject,
  type InviteKeyRecord,
} from '../contracts/portal-access.js';
import { hashApiKey } from '../auth/apiKey.js';
import { getDb } from '../db/client.js';
import { accessSession, inviteKey, inviteKeyRedemption, mintedToken } from '../db/schema.js';
import { AccessError } from './errors.js';

/** Plaintext demo key seeded in migration 0003 (mock / prism-dev). */
export const DEMO_INVITE_KEY = 'invite_demo_light_mock-project-1';
export const DEMO_INVITE_KEY_ID = 'invite-demo-light';

const ALLOWED_SET = new Set<string>(CONNECTOR_FUNCTIONS);
const DENIED_SET = new Set<string>(INVITE_KEY_DENIED_FUNCTIONS);

export function normalizeInviteFunctions(raw?: ConnectorFunction[] | null): ConnectorFunction[] {
  const source = raw?.length ? raw : LIGHT_CONNECTOR_FUNCTIONS;
  const out: ConnectorFunction[] = [];
  for (const fn of source) {
    if (!ALLOWED_SET.has(fn)) {
      throw new AccessError(`Unknown connector function: ${fn}`, 400);
    }
    if (DENIED_SET.has(fn)) {
      throw new AccessError(`Invite keys cannot grant function: ${fn}`, 400);
    }
    if (!out.includes(fn)) out.push(fn);
  }
  if (out.length === 0) {
    throw new AccessError('allowedFunctions must include at least one function', 400);
  }
  return out;
}

function generateInviteKeyPlaintext(): string {
  // URL-safe, high entropy; prefix makes logs/UI recognizable.
  return `invite_${randomBytes(24).toString('base64url')}`;
}

function toRecord(row: typeof inviteKey.$inferSelect, extras?: { key?: string; redeemUrl?: string }): InviteKeyRecord {
  const names = (row.projectNames ?? {}) as Record<string, string>;
  const projects: InviteKeyProject[] = row.orbitProjectIds.map((id) => ({
    orbitProjectId: id,
    projectName: names[id] ?? null,
  }));
  return {
    id: row.id,
    label: row.label,
    orbitTarget: row.orbitTarget as 'prod' | 'dev',
    projects,
    allowedFunctions: row.allowedFunctions as ConnectorFunction[],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastRedeemedAt: row.lastRedeemedAt?.toISOString() ?? null,
    key: extras?.key,
    redeemUrl: extras?.redeemUrl,
  };
}

export async function createInviteKey(
  input: CreateInviteKeyRequest,
  createdBy: string,
  publicBaseUrl: string,
): Promise<CreateInviteKeyResponse> {
  const projectIds = [...new Set((input.orbitProjectIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (projectIds.length === 0) {
    throw new AccessError('orbitProjectIds required', 400);
  }

  const allowedFunctions = normalizeInviteFunctions(input.allowedFunctions);
  const orbitTarget = input.orbitTarget === 'prod' ? 'prod' : 'dev';
  let expiresAt: Date | null = null;
  if (input.expiresAt) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new AccessError('expiresAt must be a valid ISO timestamp', 400);
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new AccessError('expiresAt must be in the future', 400);
    }
  }

  const maxRedemptions =
    input.maxRedemptions == null || input.maxRedemptions === undefined
      ? null
      : Number(input.maxRedemptions);
  if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
    throw new AccessError('maxRedemptions must be a positive integer', 400);
  }

  const projectNames: Record<string, string> = {};
  if (input.projectNames) {
    for (const [id, name] of Object.entries(input.projectNames)) {
      if (projectIds.includes(id) && name) projectNames[id] = name;
    }
  }

  const id = randomUUID();
  const plaintext = generateInviteKeyPlaintext();
  const keyHash = hashApiKey(plaintext);
  const keyPrefix = plaintext.slice(0, 8);
  const now = new Date();
  const db = getDb();

  await db.insert(inviteKey).values({
    id,
    keyHash,
    keyPrefix,
    label: input.label?.trim() || null,
    orbitTarget,
    orbitProjectIds: projectIds,
    projectNames,
    allowedFunctions,
    expiresAt,
    maxRedemptions,
    redemptionCount: 0,
    createdBy,
    createdAt: now,
  });

  const redeemUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/access/invite-login?key=${encodeURIComponent(plaintext)}`;
  return {
    id,
    key: plaintext,
    redeemUrl,
    expiresAt: expiresAt?.toISOString() ?? null,
    projects: projectIds.map((orbitProjectId) => ({
      orbitProjectId,
      projectName: projectNames[orbitProjectId] ?? null,
    })),
    allowedFunctions,
    label: input.label?.trim() || null,
    maxRedemptions,
  };
}

export async function listInviteKeys(): Promise<InviteKeyRecord[]> {
  const db = getDb();
  const rows = await db.select().from(inviteKey).orderBy(desc(inviteKey.createdAt));
  return rows.map((r) => toRecord(r));
}

export async function revokeInviteKey(id: string): Promise<InviteKeyRecord> {
  const db = getDb();
  const rows = await db.select().from(inviteKey).where(eq(inviteKey.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new AccessError('Invite key not found', 404);
  if (row.revokedAt) return toRecord(row);

  const now = new Date();
  await db.update(inviteKey).set({ revokedAt: now }).where(eq(inviteKey.id, id));

  // Invalidate outstanding sessions derived from this key.
  const sessions = await db
    .select()
    .from(accessSession)
    .where(and(eq(accessSession.inviteKeyId, id), isNull(accessSession.revokedAt)));

  for (const session of sessions) {
    await db.update(accessSession).set({ revokedAt: now }).where(eq(accessSession.id, session.id));
    if (session.mintedTokenId) {
      await db
        .update(mintedToken)
        .set({ revokedAt: now })
        .where(eq(mintedToken.id, session.mintedTokenId));
    }
  }

  return toRecord({ ...row, revokedAt: now });
}

export type RedeemableInviteKey = {
  id: string;
  orbitTarget: 'prod' | 'dev';
  orbitProjectIds: string[];
  projectNames: Record<string, string>;
  allowedFunctions: ConnectorFunction[];
  createdBy: string;
};

/**
 * Look up a plaintext invite key and assert it is still redeemable.
 * Does not increment redemption count — call {@link recordInviteKeyRedemption} after session mint.
 */
export async function lookupRedeemableInviteKey(plaintext: string): Promise<RedeemableInviteKey> {
  const trimmed = plaintext.trim();
  if (!trimmed) throw new AccessError('inviteKey required', 400);

  const db = getDb();
  const keyHash = hashApiKey(trimmed);
  const rows = await db.select().from(inviteKey).where(eq(inviteKey.keyHash, keyHash)).limit(1);
  const row = rows[0];
  if (!row) throw new AccessError('Invalid invite key', 401);
  if (row.revokedAt) throw new AccessError('Invite key has been revoked', 401);
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new AccessError('Invite key has expired', 401);
  }
  if (row.maxRedemptions != null && row.redemptionCount >= row.maxRedemptions) {
    throw new AccessError('Invite key has reached its redemption limit', 401);
  }

  return {
    id: row.id,
    orbitTarget: row.orbitTarget as 'prod' | 'dev',
    orbitProjectIds: row.orbitProjectIds,
    projectNames: (row.projectNames ?? {}) as Record<string, string>,
    allowedFunctions: row.allowedFunctions as ConnectorFunction[],
    createdBy: row.createdBy,
  };
}

export async function recordInviteKeyRedemption(input: {
  inviteKeyId: string;
  sessionId: string;
  orbitTarget: string;
  clientMeta?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(inviteKeyRedemption).values({
    id: randomUUID(),
    inviteKeyId: input.inviteKeyId,
    sessionId: input.sessionId,
    orbitTarget: input.orbitTarget,
    redeemedAt: now,
    clientMeta: input.clientMeta ?? null,
  });
  await db
    .update(inviteKey)
    .set({
      redemptionCount: sql`${inviteKey.redemptionCount} + 1`,
      lastRedeemedAt: now,
    })
    .where(eq(inviteKey.id, input.inviteKeyId));
}

/**
 * Resolve invite key from either `inviteKey` field or `portalAuthCode` of form `invite:…`.
 * Returns null when the request is a normal portal OAuth exchange.
 */
export function extractInviteKeyFromSessionRequest(body: {
  inviteKey?: string;
  portalAuthCode?: string;
}): string | null {
  if (body.inviteKey?.trim()) return body.inviteKey.trim();
  const code = body.portalAuthCode?.trim();
  if (code?.startsWith('invite:')) return code.slice('invite:'.length);
  return null;
}
