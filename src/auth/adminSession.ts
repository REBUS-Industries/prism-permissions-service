import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'prism_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  uid: string;
  username: string;
  iat: number;
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(unsigned.value);
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  const ageMs = Date.now() - payload.iat;
  if (ageMs < 0 || ageMs > SESSION_TTL_MS) {
    reply.status(401).send({ error: 'Session expired' });
    return;
  }
}
