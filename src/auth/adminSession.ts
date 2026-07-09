import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'prism_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  uid: string;
  username: string;
  iat: number;
}

export function readAdminSession(req: FastifyRequest): SessionPayload | null {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(unsigned.value);
  } catch {
    return null;
  }
  const ageMs = Date.now() - payload.iat;
  if (ageMs < 0 || ageMs > SESSION_TTL_MS) return null;
  return payload;
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!readAdminSession(req)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

/** Admin username from cookie, or null if unauthenticated. */
export function adminUsername(req: FastifyRequest): string | null {
  return readAdminSession(req)?.username ?? null;
}
