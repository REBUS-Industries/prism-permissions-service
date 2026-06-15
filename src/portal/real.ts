import {
  PORTAL_ACCESS_SCHEMA,
  type PortalProjectPermissionsResponse,
  type PortalUser,
} from '../contracts/portal-access.js';
import type { PortalAdapter, PortalAdapterConfig } from './adapter.js';

export class RealPortalAdapter implements PortalAdapter {
  constructor(private config: PortalAdapterConfig) {}

  private headers(extra?: Record<string, string>) {
    const h: Record<string, string> = {
      accept: 'application/json',
      ...extra,
    };
    if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async exchangeAuthCode(code: string, redirectUri?: string): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/portal/oauth/token`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ code, redirectUri, grantType: 'authorization_code' }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal token exchange failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { accessToken?: string; token?: string };
    const token = body.accessToken ?? body.token;
    if (!token) throw new Error('Portal token exchange returned no access token');
    return token;
  }

  async getMe(portalToken: string): Promise<PortalUser> {
    const res = await fetch(`${this.config.baseUrl}/portal/me`, {
      headers: this.headers({ authorization: `Bearer ${portalToken}` }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal /me failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as PortalUser;
    if (!body.userId || !body.email) throw new Error('Portal /me returned invalid payload');
    return body;
  }

  async getProjectPermissions(portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse> {
    const res = await fetch(`${this.config.baseUrl}/portal/users/${encodeURIComponent(userId)}/project-permissions`, {
      headers: this.headers({ authorization: `Bearer ${portalToken}` }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal project-permissions failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { projects?: PortalProjectPermissionsResponse['projects'] };
    return {
      schema: PORTAL_ACCESS_SCHEMA,
      userId,
      projects: body.projects ?? [],
      fetchedAt: new Date().toISOString(),
    };
  }
}
