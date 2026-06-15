import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PortalAdapter } from '../portal/adapter.js';
import type { AccessSessionRequest } from '../contracts/portal-access.js';
import { AccessError, exchangePortalSession, getSessionManifest, revokeSession } from '../access/session.js';
import { resolvePortalUser } from '../access/portalUser.js';
import { checkProvisionedAdmin } from '../workspace/service.js';
import { getIntegrationSetting, getIntegrationSettingOr } from '../config/integrationSettings.js';

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
      if (!body.portalAuthCode) {
        return reply.status(400).send({ error: 'portalAuthCode required' });
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
  }));
}
