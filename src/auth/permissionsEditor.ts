import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { hashApiKey } from './apiKey.js';
import { requireAdmin } from './adminSession.js';

declare module 'fastify' {
  interface FastifyRequest {
    permissionsEditorKind?: 'admin' | 'apiKey';
    permissionsEditorScopes?: string[];
  }
}

export async function tryAuthApiKey(req: FastifyRequest): Promise<boolean> {
  const header = req.headers['x-api-key'];
  if (typeof header !== 'string' || header.length === 0) return false;

  const hash = hashApiKey(header);
  const db = getDb();
  const rows = await db.execute<{ id: string; scopes: unknown }>(sql`
    SELECT id, scopes FROM api_keys
    WHERE key_hash = ${hash} AND is_active = true
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return false;

  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((s): s is string => typeof s === 'string')
    : [];

  req.permissionsEditorKind = 'apiKey';
  req.permissionsEditorScopes = scopes;
  return true;
}

export async function requirePermissionsEditor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies?.prism_admin;
  if (raw) {
    const unsigned = req.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) {
      req.permissionsEditorKind = 'admin';
      return;
    }
  }

  if (await tryAuthApiKey(req)) {
    const scopes = req.permissionsEditorScopes ?? [];
    if (scopes.includes('access:admin')) return;
  }

  reply.status(401).send({ error: 'Unauthorized' });
}

export async function requireInternalServiceKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.PERMISSIONS_INTERNAL_KEY?.trim();
  if (!expected) {
    reply.status(503).send({ error: 'PERMISSIONS_INTERNAL_KEY not configured' });
    return;
  }
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token !== expected) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
}
