import {
  PORTAL_ACCESS_SCHEMA,
  type PortalProjectPermissionsResponse,
  type PortalRole,
  type PortalRolesResponse,
  type PortalUser,
} from '../contracts/portal-access.js';
import { getIntegrationSetting, getIntegrationSettingOr } from '../config/integrationSettings.js';
import type { PortalAdapter, PortalAdapterConfig } from './adapter.js';

export class RealPortalAdapter implements PortalAdapter {
  constructor(private config: PortalAdapterConfig) {}

  /**
   * Base URL + service key are read live from settings (cached ~15s) so the
   * admin can set them in Settings → Portal access key without a restart;
   * the boot-time config is the fallback.
   */
  private async baseUrl(): Promise<string> {
    return (await getIntegrationSettingOr('portal_base_url', this.config.baseUrl)).replace(/\/$/, '');
  }

  private async apiKey(): Promise<string | undefined> {
    return (await getIntegrationSetting('portal_api_key')) ?? this.config.apiKey;
  }

  private async headers(extra?: Record<string, string>) {
    const h: Record<string, string> = {
      accept: 'application/json',
      ...extra,
    };
    if (!h.authorization) {
      const key = await this.apiKey();
      if (key) h.authorization = `Bearer ${key}`;
    }
    return h;
  }

  async exchangeAuthCode(code: string, redirectUri?: string): Promise<string> {
    const res = await fetch(`${await this.baseUrl()}/portal/oauth/token`, {
      method: 'POST',
      headers: { ...(await this.headers()), 'content-type': 'application/json' },
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
    const res = await fetch(`${await this.baseUrl()}/portal/me`, {
      headers: await this.headers({ authorization: `Bearer ${portalToken}` }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal /me failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as PortalUser & { roleId?: string | null; roleIds?: unknown };
    if (!body.userId || !body.email) throw new Error('Portal /me returned invalid payload');
    const roleIds = Array.isArray(body.roleIds)
      ? body.roleIds.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : null;
    return {
      userId: body.userId,
      email: body.email,
      googleSub: body.googleSub ?? null,
      displayName: body.displayName ?? null,
      // Portal keys everything on role ids now (GET /portal/me.roleId / roleIds).
      roleId: body.roleId ?? null,
      roleIds,
      // Legacy fields kept for backward-compat with older portal builds.
      role: body.role ?? null,
      customRoleId: body.customRoleId ?? null,
    };
  }

  async getProjectPermissions(portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse> {
    const res = await fetch(`${await this.baseUrl()}/portal/users/${encodeURIComponent(userId)}/project-permissions`, {
      headers: await this.headers({ authorization: `Bearer ${portalToken}` }),
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

  async listRoles(): Promise<PortalRolesResponse> {
    const res = await fetch(`${await this.baseUrl()}/portal/roles`, { headers: await this.headers() });
    // The portal may not implement the roles endpoint yet — degrade gracefully
    // so PRISM falls back to deriving roles from existing grants.
    if (res.status === 404 || res.status === 501) {
      return { roles: [], supported: false, fetchedAt: new Date().toISOString() };
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal /roles failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { roles?: Array<Partial<PortalRole>> };
    const roles: PortalRole[] = (body.roles ?? [])
      .map((r) => ({
        id: String(r.id ?? '').trim(),
        name: r.name ?? null,
        system: Boolean(r.system),
      }))
      .filter((r) => r.id.length > 0);
    return { roles, supported: true, fetchedAt: new Date().toISOString() };
  }
}
