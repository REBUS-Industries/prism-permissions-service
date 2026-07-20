import { OAuth2Client } from 'google-auth-library';
import {
  PORTAL_ACCESS_SCHEMA,
  type PortalProjectPermissionsBulkResponse,
  type PortalProjectPermissionsResponse,
  type PortalRolesResponse,
  type PortalUser,
} from '../contracts/portal-access.js';
import { getIntegrationSetting } from '../config/integrationSettings.js';
import type { PortalAdapter } from './adapter.js';

/** Direct Google Workspace OAuth — no REBUS portal required. */
export class GooglePortalAdapter implements PortalAdapter {
  private async oauthClient(redirectUri?: string): Promise<OAuth2Client> {
    const clientId = await getIntegrationSetting('google_oauth_client_id');
    const clientSecret = await getIntegrationSetting('google_oauth_client_secret');
    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth client ID and secret are not configured in Settings');
    }
    return new OAuth2Client(clientId, clientSecret, redirectUri);
  }

  async exchangeAuthCode(code: string, redirectUri?: string): Promise<string> {
    if (!redirectUri?.trim()) {
      throw new Error(
        'redirectUri required for Google OAuth code exchange (connector must send http://localhost:29364/)',
      );
    }
    const client = await this.oauthClient(redirectUri);
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
    const accessToken = tokens.access_token;
    if (!accessToken) throw new Error('Google token exchange returned no access token');
    return accessToken;
  }

  async getMe(portalToken: string): Promise<PortalUser> {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${portalToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Google userinfo failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { sub?: string; email?: string; name?: string };
    if (!body.sub || !body.email) throw new Error('Google userinfo returned invalid payload');
    return {
      userId: body.sub,
      email: body.email,
      googleSub: body.sub,
      displayName: body.name ?? null,
    };
  }

  async getProjectPermissions(_portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse> {
    // No REBUS portal — project access stays on provisioned_user.projectPermissions.
    return {
      schema: PORTAL_ACCESS_SCHEMA,
      userId,
      projects: [],
      supported: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  async listAllProjectPermissions(): Promise<PortalProjectPermissionsBulkResponse> {
    return {
      users: [],
      nextCursor: null,
      supported: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  async listRoles(): Promise<PortalRolesResponse> {
    // Direct Google Workspace OAuth has no PRISM role catalogue; PRISM falls
    // back to deriving role nodes from existing tool grants.
    return { roles: [], supported: false, fetchedAt: new Date().toISOString() };
  }
}
