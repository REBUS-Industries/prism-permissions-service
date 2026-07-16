import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PortalAdapter } from '../portal/adapter.js';
import type {
  AccessSessionRequest,
  CreateInviteKeyRequest,
  PrismTool,
  ToolAuthorizeRequest,
  UpdateInviteKeyRequest,
} from '../contracts/portal-access.js';
import { AccessError, exchangePortalSession, getSessionManifest, revokeSession } from '../access/session.js';
import {
  createInviteKey,
  DEMO_INVITE_KEY,
  listInviteKeys,
  lookupRedeemableInviteKey,
  revealInviteKey,
  revokeInviteKey,
  rotateInviteKey,
  updateInviteKey,
} from '../access/inviteKeys.js';
import { resolvePortalUser } from '../access/portalUser.js';
import { authorizeTool, fullLocalAdminToolAccess, resolveEmailFromAdminUsername, resolveToolAccess } from '../access/tools.js';
import { checkProvisionedAdmin } from '../workspace/service.js';
import { adminUsername, requireAdmin } from '../auth/adminSession.js';
import { requireInternalServiceKey } from '../auth/permissionsEditor.js';
import { getIntegrationSetting, getIntegrationSettingOr } from '../config/integrationSettings.js';

const COOKIE_NAME = 'prism_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function resolveEmailFromAdminCookie(req: FastifyRequest): Promise<string | null> {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    const payload = JSON.parse(unsigned.value) as { username?: string; iat?: number };
    if (!payload.username || !payload.iat) return null;
    const ageMs = Date.now() - payload.iat;
    if (ageMs < 0 || ageMs > SESSION_TTL_MS) return null;
    return resolveEmailFromAdminUsername(payload.username);
  } catch {
    return null;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

function publicBaseUrl(req: FastifyRequest): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] ?? req.hostname;
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  return `${proto}://${host}`.replace(/\/$/, '');
}

/** Build browser URL for connector "Sign in with REBUS" (Google or mock). */
async function buildAccessLoginUrl(redirectUri: string): Promise<string> {
  const adapter = (await getIntegrationSettingOr('portal_adapter', 'mock')).toLowerCase();

  if (adapter === 'mock') {
    const persona = await getIntegrationSettingOr('portal_mock_persona', 'alice');
    return `/api/access/mock-login?redirect_uri=${encodeURIComponent(redirectUri)}&persona=${encodeURIComponent(persona)}`;
  }

  if (adapter === 'google') {
    const clientId = await getIntegrationSetting('google_oauth_client_id');
    if (!clientId) {
      throw new AccessError('Google OAuth is not configured in PRISM Settings', 503);
    }
    const scopes = await getIntegrationSettingOr('google_oauth_scopes', 'openid email profile');
    const domain = await getIntegrationSetting('workspace_domain');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    if (domain) url.searchParams.set('hd', domain);
    return url.toString();
  }

  const authorizeBase = (await getIntegrationSetting('portal_google_authorize_url'))?.trim();
  if (!authorizeBase) {
    throw new AccessError('Portal Google authorize URL is not configured', 503);
  }
  const url = new URL(authorizeBase);
  url.searchParams.set('redirect_uri', redirectUri);
  return url.toString();
}

export async function registerAccessRoutes(app: FastifyInstance, portal: PortalAdapter) {
  /** Dev-only mock portal redirect (mock adapter). */
  app.get<{ Querystring: { redirect_uri?: string; persona?: string } }>(
    '/api/access/mock-login',
    async (req, reply) => {
      if (process.env.NODE_ENV === 'production' && (await getIntegrationSettingOr('portal_adapter', 'mock')) !== 'mock') {
        return reply.status(404).send({ error: 'Not found' });
      }
      const redirect = req.query.redirect_uri;
      if (!redirect) return reply.status(400).send({ error: 'redirect_uri required' });
      const persona = req.query.persona ?? (await getIntegrationSettingOr('portal_mock_persona', 'alice'));
      const url = new URL(redirect);
      url.searchParams.set('code', `mock:${persona}`);
      return reply.redirect(url.toString());
    },
  );

  /** Connector OAuth entry — redirects to Google (or mock-login) with connector loopback callback. */
  app.get<{ Querystring: { redirect_uri?: string } }>('/api/access/login', async (req, reply) => {
    const redirectUri = req.query.redirect_uri?.trim();
    if (!redirectUri) return reply.status(400).send({ error: 'redirect_uri required' });
    try {
      const target = await buildAccessLoginUrl(redirectUri);
      if (target.startsWith('/')) {
        return reply.redirect(`${publicBaseUrl(req)}${target}`);
      }
      return reply.redirect(target);
    } catch (err) {
      if (err instanceof AccessError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error(err);
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'Login redirect failed' });
    }
  });

  app.get<{ Querystring: { email?: string } }>('/api/access/provisioned-admin', async (req, reply) => {
    const email = req.query.email?.trim();
    if (!email) return reply.status(400).send({ error: 'email required' });
    return checkProvisionedAdmin(email);
  });

  app.get('/api/access/me', async (req, reply) => {
    const adminEmail = await resolveEmailFromAdminCookie(req);
    if (adminEmail) {
      return fullLocalAdminToolAccess(adminEmail);
    }

    const token = bearerToken(req);
    if (!token) return reply.status(401).send({ error: 'authentication required' });
    try {
      const portalUser = await portal.getMe(token);
      return resolveToolAccess({ email: portalUser.email, portalUser });
    } catch (err) {
      req.log.warn({ err }, 'access/me portal token failed');
      return reply.status(401).send({ error: 'invalid or expired token' });
    }
  });

  app.post<{ Body: ToolAuthorizeRequest }>(
    '/api/access/authorize',
    { preHandler: requireInternalServiceKey },
    async (req, reply) => {
      const email = req.body?.email?.trim();
      const tool = req.body?.tool;
      if (!email || !tool) {
        return reply.status(400).send({ error: 'email and tool required' });
      }
      const allowed = await authorizeTool(email, tool as PrismTool);
      return { allowed, email: email.toLowerCase(), tool };
    },
  );

  app.post<{ Body: { portalAuthCode?: string; redirectUri?: string } }>(
    '/api/access/portal-user',
    async (req, reply) => {
      const portalAuthCode = req.body?.portalAuthCode;
      if (!portalAuthCode) return reply.status(400).send({ error: 'portalAuthCode required' });
      try {
        const user = await resolvePortalUser(portal, portalAuthCode, req.body?.redirectUri);
        return { user };
      } catch (err) {
        req.log.warn({ err }, 'portal-user exchange failed');
        return reply.status(401).send({ error: err instanceof Error ? err.message : 'Portal sign-in failed' });
      }
    },
  );

  app.post<{ Body: AccessSessionRequest }>('/api/access/session', async (req, reply) => {
    try {
      const body = req.body ?? ({} as AccessSessionRequest);
      if (!body.portalAuthCode && !body.inviteKey) {
        return reply.status(400).send({ error: 'portalAuthCode or inviteKey required' });
      }
      const result = await exchangePortalSession(portal, body);
      return { manifest: result.manifest };
    } catch (err) {
      if (err instanceof AccessError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error(err);
      const message = err instanceof Error ? err.message : 'Session exchange failed';
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Browser redeem for Connector Light (parity with portal OAuth loopback).
   * Redirects to redirect_uri?code=invite:<key> so the connector can POST /session.
   */
  app.get<{ Querystring: { key?: string; redirect_uri?: string } }>(
    '/api/access/invite-login',
    async (req, reply) => {
      const key = req.query.key?.trim();
      const redirectUri = req.query.redirect_uri?.trim();
      if (!key) return reply.status(400).send({ error: 'key required' });
      if (!redirectUri) return reply.status(400).send({ error: 'redirect_uri required' });
      try {
        // Validate before redirect so bad keys fail here, not after loopback.
        await lookupRedeemableInviteKey(key);
      } catch (err) {
        if (err instanceof AccessError) {
          return reply.status(err.status).send({ error: err.message });
        }
        throw err;
      }
      const url = new URL(redirectUri);
      url.searchParams.set('code', `invite:${key}`);
      return reply.redirect(url.toString());
    },
  );

  // Register on `app` (not a nested plugin) so routes always appear in the
  // root router — nested register has been observed missing after some deploys.
  app.post<{ Body: CreateInviteKeyRequest }>(
    '/api/access/invite-keys',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const createdBy = adminUsername(req) ?? 'admin';
        const result = await createInviteKey(req.body ?? {}, createdBy, publicBaseUrl(req));
        return result;
      } catch (err) {
        if (err instanceof AccessError) {
          return reply.status(err.status).send({ error: err.message });
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'Failed to create invite key' });
      }
    },
  );

  app.get('/api/access/invite-keys', { preHandler: requireAdmin }, async () => {
    return { keys: await listInviteKeys() };
  });

  app.patch<{ Params: { id: string }; Body: UpdateInviteKeyRequest }>(
    '/api/access/invite-keys/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const key = await updateInviteKey(req.params.id, req.body ?? {});
        return { key };
      } catch (err) {
        if (err instanceof AccessError) {
          return reply.status(err.status).send({ error: err.message });
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'Failed to update invite key' });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/access/invite-keys/:id/revoke',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const key = await revokeInviteKey(req.params.id);
        return { key };
      } catch (err) {
        if (err instanceof AccessError) {
          return reply.status(err.status).send({ error: err.message });
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'Failed to revoke invite key' });
      }
    },
  );

  /** Reveal sealed plaintext for an existing invite key (admin cookie). */
  app.get<{ Params: { id: string } }>(
    '/api/access/invite-keys/:id/reveal',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return await revealInviteKey(req.params.id, publicBaseUrl(req));
      } catch (err) {
        if (err instanceof AccessError) {
          return reply.status(err.status).send({ error: err.message });
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'Failed to reveal invite key' });
      }
    },
  );

  /** Issue a new plaintext when the old one is not recoverable. */
  app.post<{ Params: { id: string } }>(
    '/api/access/invite-keys/:id/rotate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return await rotateInviteKey(req.params.id, publicBaseUrl(req));
      } catch (err) {
        if (err instanceof AccessError) {
          return reply.status(err.status).send({ error: err.message });
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'Failed to rotate invite key' });
      }
    },
  );

  /** Dev helper: echo the seeded demo invite key when mock adapter is active. */
  app.get('/api/access/invite-keys/demo', async (req, reply) => {
    const adapter = (await getIntegrationSettingOr('portal_adapter', 'mock')).toLowerCase();
    if (process.env.NODE_ENV === 'production' && adapter !== 'mock') {
      return reply.status(404).send({ error: 'Not found' });
    }
    return {
      id: 'invite-demo-light',
      key: DEMO_INVITE_KEY,
      orbitProjectId: 'mock-project-1',
      allowedFunctions: ['send', 'create_model', 'create_version', 'list_models', 'list_versions'],
      note: 'Seeded demo key for REBUS Connector Light testing (mock adapter).',
    };
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/access/manifest', async (req, reply) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    try {
      const manifest = await getSessionManifest(sessionId);
      return { manifest };
    } catch (err) {
      if (err instanceof AccessError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error(err);
      return reply.status(500).send({ error: 'Failed to load manifest' });
    }
  });

  app.post<{ Body: { sessionId?: string } }>('/api/access/revoke', async (req, reply) => {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    await revokeSession(sessionId);
    return { ok: true };
  });

  app.get('/api/access/health', async () => ({
    status: 'ok',
    adapter: await getIntegrationSettingOr('portal_adapter', 'mock'),
    features: { inviteKeys: true },
    revision: process.env.GIT_SHA ?? process.env.npm_package_version ?? null,
  }));
}

