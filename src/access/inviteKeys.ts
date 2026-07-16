import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  CONNECTOR_FUNCTIONS,
  INVITE_MODEL_ACCESS_MODES,
  LIGHT_CONNECTOR_FUNCTIONS,
  type ConnectorFunction,
  type CreateInviteKeyRequest,
  type CreateInviteKeyResponse,
  type InviteKeyProject,
  type InviteKeyRecord,
  type InviteModelAccess,
  type UpdateInviteKeyRequest,
} from '../contracts/portal-access.js';
import { hashApiKey } from '../auth/apiKey.js';
import { openSecret, sealSecret } from '../crypto/secretBox.js';
import { getDb } from '../db/client.js';
import { accessSession, inviteKey, inviteKeyRedemption, mintedToken } from '../db/schema.js';
import { AccessError } from './errors.js';

/** Plaintext demo key seeded in migration 0003 (mock / prism-dev). */
export const DEMO_INVITE_KEY = 'invite_demo_light_mock-project-1';
export const DEMO_INVITE_KEY_ID = 'invite-demo-light';

const ALLOWED_SET = new Set<string>(CONNECTOR_FUNCTIONS);
const MODEL_ACCESS_SET = new Set<string>(INVITE_MODEL_ACCESS_MODES);

/**
 * Normalize invite-key allowedFunctions.
 * - Missing/empty → LIGHT_CONNECTOR_FUNCTIONS (send-only default).
 * - Any {@link CONNECTOR_FUNCTIONS} value is accepted (including receive).
 * - Unknown names → 400.
 */
export function normalizeInviteFunctions(raw?: ConnectorFunction[] | null): ConnectorFunction[] {
  const source = raw?.length ? raw : LIGHT_CONNECTOR_FUNCTIONS;
  const out: ConnectorFunction[] = [];
  for (const fn of source) {
    if (!ALLOWED_SET.has(fn)) {
      throw new AccessError(`Unknown connector function: ${fn}`, 400);
    }
    if (!out.includes(fn)) out.push(fn);
  }
  if (out.length === 0) {
    throw new AccessError('allowedFunctions must include at least one function', 400);
  }
  return out;
}

export function normalizeModelAccess(
  mode?: InviteModelAccess | null,
  selectedModelIds?: string[] | null,
): { modelAccess: InviteModelAccess; selectedModelIds: string[] } {
  const modelAccess: InviteModelAccess = mode && MODEL_ACCESS_SET.has(mode) ? mode : 'all';
  if (mode && !MODEL_ACCESS_SET.has(mode)) {
    throw new AccessError(`Unknown modelAccess: ${mode}`, 400);
  }
  const ids = [...new Set((selectedModelIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (modelAccess === 'selected' && ids.length === 0) {
    throw new AccessError('selectedModelIds required when modelAccess is selected', 400);
  }
  return {
    modelAccess,
    selectedModelIds: modelAccess === 'selected' ? ids : [],
  };
}

function generateInviteKeyPlaintext(): string {
  // URL-safe, high entropy; prefix makes logs/UI recognizable.
  return `invite_${randomBytes(24).toString('base64url')}`;
}

function buildRedeemUrl(publicBaseUrl: string, plaintext: string): string {
  return `${publicBaseUrl.replace(/\/$/, '')}/api/access/invite-login?key=${encodeURIComponent(plaintext)}`;
}

export interface RevealInviteKeyResponse {
  id: string;
  key: string;
  redeemUrl: string;
  /** True when plaintext was recovered from sealed storage (or known demo key). */
  recoverable: boolean;
}

function toRecord(row: typeof inviteKey.$inferSelect, extras?: { key?: string; redeemUrl?: string }): InviteKeyRecord {
  const names = (row.projectNames ?? {}) as Record<string, string>;
  const projects: InviteKeyProject[] = row.orbitProjectIds.map((id) => ({
    orbitProjectId: id,
    projectName: names[id] ?? null,
  }));
  const modelAccess = (MODEL_ACCESS_SET.has(row.modelAccess) ? row.modelAccess : 'all') as InviteModelAccess;
  return {
    id: row.id,
    label: row.label,
    orbitTarget: row.orbitTarget as 'prod' | 'dev',
    projects,
    allowedFunctions: row.allowedFunctions as ConnectorFunction[],
    modelAccess,
    selectedModelIds: modelAccess === 'selected' ? ((row.selectedModelIds ?? []) as string[]) : [],
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

  const { modelAccess, selectedModelIds } = normalizeModelAccess(
    input.modelAccess,
    input.selectedModelIds,
  );

  const id = randomUUID();
  const plaintext = generateInviteKeyPlaintext();
  const keyHash = hashApiKey(plaintext);
  const keyPrefix = plaintext.slice(0, 8);
  let keyCiphertext: string;
  try {
    keyCiphertext = sealSecret(plaintext);
  } catch (err) {
    throw new AccessError(
      err instanceof Error ? err.message : 'Failed to seal invite key',
      503,
    );
  }
  const now = new Date();
  const db = getDb();

  await db.insert(inviteKey).values({
    id,
    keyHash,
    keyPrefix,
    keyCiphertext,
    label: input.label?.trim() || null,
    orbitTarget,
    orbitProjectIds: projectIds,
    projectNames,
    allowedFunctions,
    modelAccess,
    selectedModelIds,
    expiresAt,
    maxRedemptions,
    redemptionCount: 0,
    createdBy,
    createdAt: now,
  });

  const redeemUrl = buildRedeemUrl(publicBaseUrl, plaintext);
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
    modelAccess,
    selectedModelIds,
  };
}

export async function listInviteKeys(): Promise<InviteKeyRecord[]> {
  const db = getDb();
  const rows = await db.select().from(inviteKey).orderBy(desc(inviteKey.createdAt));
  return rows.map((r) => toRecord(r));
}


export async function updateInviteKey(id: string, input: UpdateInviteKeyRequest): Promise<InviteKeyRecord> {
  const db = getDb();
  const rows = await db.select().from(inviteKey).where(eq(inviteKey.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new AccessError('Invite key not found', 404);
  if (row.revokedAt) throw new AccessError('Revoked invite keys cannot be edited', 400);

  const patch: Partial<typeof inviteKey.$inferInsert> = {};

  if (input.label !== undefined) {
    patch.label = input.label?.trim() || null;
  }

  if (input.orbitProjectIds !== undefined) {
    const projectIds = [...new Set(input.orbitProjectIds.map((pid) => pid.trim()).filter(Boolean))];
    if (projectIds.length === 0) {
      throw new AccessError('orbitProjectIds required', 400);
    }
    patch.orbitProjectIds = projectIds;
    const names: Record<string, string> = { ...(row.projectNames ?? {}) };
    if (input.projectNames) {
      for (const [pid, name] of Object.entries(input.projectNames)) {
        if (projectIds.includes(pid) && name) names[pid] = name;
      }
    }
    for (const pid of Object.keys(names)) {
      if (!projectIds.includes(pid)) delete names[pid];
    }
    patch.projectNames = names;
  } else if (input.projectNames !== undefined && input.projectNames) {
    const names = { ...(row.projectNames ?? {}) };
    for (const [pid, name] of Object.entries(input.projectNames)) {
      if (row.orbitProjectIds.includes(pid) && name) names[pid] = name;
    }
    patch.projectNames = names;
  }

  if (input.allowedFunctions !== undefined) {
    patch.allowedFunctions = normalizeInviteFunctions(input.allowedFunctions);
  }

  if (input.expiresAt !== undefined) {
    if (input.expiresAt == null || input.expiresAt === '') {
      patch.expiresAt = null;
    } else {
      const expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new AccessError('expiresAt must be a valid ISO timestamp', 400);
      }
      if (expiresAt.getTime() <= Date.now()) {
        throw new AccessError('expiresAt must be in the future', 400);
      }
      patch.expiresAt = expiresAt;
    }
  }

  if (input.maxRedemptions !== undefined) {
    const maxRedemptions =
      input.maxRedemptions == null ? null : Number(input.maxRedemptions);
    if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
      throw new AccessError('maxRedemptions must be a positive integer', 400);
    }
    patch.maxRedemptions = maxRedemptions;
  }

  if (input.modelAccess !== undefined || input.selectedModelIds !== undefined) {
    const currentMode = (MODEL_ACCESS_SET.has(row.modelAccess) ? row.modelAccess : 'all') as InviteModelAccess;
    const normalized = normalizeModelAccess(
      input.modelAccess !== undefined ? input.modelAccess : currentMode,
      input.selectedModelIds !== undefined
        ? input.selectedModelIds
        : (row.selectedModelIds as string[]),
    );
    patch.modelAccess = normalized.modelAccess;
    patch.selectedModelIds = normalized.selectedModelIds;
  }

  if (Object.keys(patch).length === 0) {
    return toRecord(row);
  }

  await db.update(inviteKey).set(patch).where(eq(inviteKey.id, id));
  const updated = await db.select().from(inviteKey).where(eq(inviteKey.id, id)).limit(1);
  return toRecord(updated[0]!);
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

/**
 * Reveal the invite-key plaintext for an admin (after create / later).
 * Keys minted before ciphertext storage cannot be recovered — use
 * {@link rotateInviteKey} to issue a new plaintext.
 */
export async function revealInviteKey(
  id: string,
  publicBaseUrl: string,
): Promise<RevealInviteKeyResponse> {
  const db = getDb();
  const rows = await db.select().from(inviteKey).where(eq(inviteKey.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new AccessError('Invite key not found', 404);
  if (row.revokedAt) throw new AccessError('Invite key has been revoked', 400);

  // Seeded demo key — plaintext is public in docs / mock adapter.
  if (row.id === DEMO_INVITE_KEY_ID) {
    return {
      id: row.id,
      key: DEMO_INVITE_KEY,
      redeemUrl: buildRedeemUrl(publicBaseUrl, DEMO_INVITE_KEY),
      recoverable: true,
    };
  }

  const sealed = row.keyCiphertext?.trim();
  if (!sealed) {
    throw new AccessError(
      'Invite key plaintext is not recoverable (created before reveal storage). Rotate the key to issue a new plaintext.',
      409,
    );
  }

  let plaintext: string;
  try {
    plaintext = openSecret(sealed);
  } catch {
    throw new AccessError(
      'Failed to decrypt invite key. Check SESSION_SECRET matches the value used when the key was created, or rotate the key.',
      503,
    );
  }

  // Integrity: sealed value must still match the stored hash.
  if (hashApiKey(plaintext) !== row.keyHash) {
    throw new AccessError('Invite key ciphertext does not match stored hash — rotate the key.', 409);
  }

  return {
    id: row.id,
    key: plaintext,
    redeemUrl: buildRedeemUrl(publicBaseUrl, plaintext),
    recoverable: true,
  };
}

/**
 * Replace the plaintext (and hash) for an invite key. Invalidates prior
 * redemptions that used the old string; existing sessions are left intact
 * until they expire or the key is revoked.
 */
export async function rotateInviteKey(
  id: string,
  publicBaseUrl: string,
): Promise<RevealInviteKeyResponse> {
  const db = getDb();
  const rows = await db.select().from(inviteKey).where(eq(inviteKey.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new AccessError('Invite key not found', 404);
  if (row.revokedAt) throw new AccessError('Revoked invite keys cannot be rotated', 400);
  if (row.id === DEMO_INVITE_KEY_ID) {
    throw new AccessError('Demo invite key cannot be rotated', 400);
  }

  const plaintext = generateInviteKeyPlaintext();
  let keyCiphertext: string;
  try {
    keyCiphertext = sealSecret(plaintext);
  } catch (err) {
    throw new AccessError(
      err instanceof Error ? err.message : 'Failed to seal invite key',
      503,
    );
  }

  await db
    .update(inviteKey)
    .set({
      keyHash: hashApiKey(plaintext),
      keyPrefix: plaintext.slice(0, 8),
      keyCiphertext,
    })
    .where(eq(inviteKey.id, id));

  return {
    id,
    key: plaintext,
    redeemUrl: buildRedeemUrl(publicBaseUrl, plaintext),
    recoverable: true,
  };
}

export type RedeemableInviteKey = {
  id: string;
  label?: string | null;
  orbitTarget: 'prod' | 'dev';
  orbitProjectIds: string[];
  projectNames: Record<string, string>;
  allowedFunctions: ConnectorFunction[];
  modelAccess: InviteModelAccess;
  selectedModelIds: string[];
  createdBy: string;
};

function toRedeemable(row: typeof inviteKey.$inferSelect): RedeemableInviteKey {
  const modelAccess = (MODEL_ACCESS_SET.has(row.modelAccess) ? row.modelAccess : 'all') as InviteModelAccess;
  return {
    id: row.id,
    label: row.label,
    orbitTarget: row.orbitTarget as 'prod' | 'dev',
    orbitProjectIds: row.orbitProjectIds,
    projectNames: (row.projectNames ?? {}) as Record<string, string>,
    allowedFunctions: row.allowedFunctions as ConnectorFunction[],
    modelAccess,
    selectedModelIds: modelAccess === 'selected' ? ((row.selectedModelIds ?? []) as string[]) : [],
    createdBy: row.createdBy,
  };
}

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

  return toRedeemable(row);
}

/**
 * Load an invite key by id for refreshing an existing session.
 * Revoked / expired keys fail closed. Redemption limits do not block refresh
 * (the session was already minted).
 */
export async function loadInviteKeyForSessionRefresh(id: string): Promise<RedeemableInviteKey> {
  const trimmed = id.trim();
  if (!trimmed) throw new AccessError('inviteKeyId required', 400);

  const db = getDb();
  const rows = await db.select().from(inviteKey).where(eq(inviteKey.id, trimmed)).limit(1);
  const row = rows[0];
  if (!row) throw new AccessError('Invite key not found', 404);
  if (row.revokedAt) throw new AccessError('Invite key has been revoked', 401);
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new AccessError('Invite key has expired', 401);
  }

  return toRedeemable(row);
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
