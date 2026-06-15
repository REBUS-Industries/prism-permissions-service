import type { FastifyInstance } from 'fastify';
import type { PortalAdapter } from '../portal/adapter.js';
import type { AccessSessionRequest } from '../contracts/portal-access.js';
import { AccessError, exchangePortalSession, getSessionManifest, revokeSession } from '../access/session.js';
import { resolvePortalUser } from '../access/portalUser.js';
import { checkProvisionedAdmin } from '../workspace/service.js';
import { getIntegrationSettingOr } from '../config/integrationSettings.js';

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
      return reply.status(500).send({ error: 'Session exchange failed' });
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
