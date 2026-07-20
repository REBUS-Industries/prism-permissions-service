import {
  PORTAL_ACCESS_SCHEMA,
  type PortalProjectPermission,
  type PortalProjectPermissionsBulkResponse,
  type PortalProjectPermissionsResponse,
  type PortalRole,
  type PortalRolesResponse,
  type PortalUser,
} from '../contracts/portal-access.js';
import { getIntegrationSetting, getIntegrationSettingOr } from '../config/integrationSettings.js';
import type { PortalAdapter, PortalAdapterConfig } from './adapter.js';

function normaliseProjects(raw: unknown): PortalProjectPermission[] {
  if (!Array.isArray(raw)) return [];
  const out: PortalProjectPermission[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const orbitProjectId = String((row as { orbitProjectId?: unknown }).orbitProjectId ?? '').trim();
    const level = String((row as { level?: unknown }).level ?? '').trim().toLowerCase();
    if (!orbitProjectId) continue;
    if (level !== 'viewer' && level !== 'contributor' && level !== 'owner' && level !== 'admin') continue;
    const projectName = (row as { projectName?: unknown }).projectName;
    out.push({
      orbitProjectId,
      level,
      projectName: typeof projectName === 'string' ? projectName : null,
    });
  }
  return out;
}

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
    // Prefer the user token when present; otherwise use the service API key
    // (portal handoff: service-key auth on this route for Prism sync).
    const authExtra = portalToken.trim()
      ? { authorization: `Bearer ${portalToken}` }
      : undefined;
    const res = await fetch(`${await this.baseUrl()}/portal/users/${encodeURIComponent(userId)}/project-permissions`, {
      headers: await this.headers(authExtra),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal project-permissions failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { projects?: unknown };
    return {
      schema: PORTAL_ACCESS_SCHEMA,
      userId,
      projects: normaliseProjects(body.projects),
      supported: true,
      fetchedAt: new Date().toISOString(),
    };
  }

  async listAllProjectPermissions(opts?: {
    cursor?: string;
    limit?: number;
    domain?: string;
  }): Promise<PortalProjectPermissionsBulkResponse> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.domain) params.set('domain', opts.domain);
    const qs = params.toString();
    const url = `${await this.baseUrl()}/portal/project-permissions${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { headers: await this.headers() });
    if (res.status === 404 || res.status === 501) {
      return {
        users: [],
        nextCursor: null,
        supported: false,
        fetchedAt: new Date().toISOString(),
      };
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Portal bulk project-permissions failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as {
      users?: Array<{ userId?: unknown; email?: unknown; projects?: unknown }>;
      nextCursor?: string | null;
    };
    const users = (body.users ?? [])
      .map((u) => ({
        userId: String(u.userId ?? '').trim(),
        email: String(u.email ?? '').trim().toLowerCase(),
        projects: normaliseProjects(u.projects),
      }))
      .filter((u) => u.userId && u.email);
    return {
      users,
      nextCursor: body.nextCursor ?? null,
      supported: true,
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
