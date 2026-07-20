import type {
  PortalProjectPermission,
  PortalProjectPermissionsBulkResponse,
  PortalProjectPermissionsResponse,
  PortalRolesResponse,
  PortalUser,
} from '../contracts/portal-access.js';

export interface PortalAdapter {
  /** Exchange portal OAuth code for a portal bearer token. */
  exchangeAuthCode(code: string, redirectUri?: string): Promise<string>;
  /** Resolve portal identity from portal bearer token. */
  getMe(portalToken: string): Promise<PortalUser>;
  /** Fetch project permissions for a portal user. */
  getProjectPermissions(portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse>;
  /** List the portal's current roles (service-to-portal call; no user token). */
  listRoles(): Promise<PortalRolesResponse>;
  /** Bulk pull of portal project memberships (service-key). */
  listAllProjectPermissions(opts?: {
    cursor?: string;
    limit?: number;
    domain?: string;
  }): Promise<PortalProjectPermissionsBulkResponse>;
}

export interface PortalAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  cacheTtlMs: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class CachedPortalAdapter implements PortalAdapter {
  private permCache = new Map<string, CacheEntry<PortalProjectPermissionsResponse>>();
  private rolesCache: CacheEntry<PortalRolesResponse> | null = null;

  constructor(
    private inner: PortalAdapter,
    private ttlMs: number,
  ) {}

  exchangeAuthCode(code: string, redirectUri?: string) {
    return this.inner.exchangeAuthCode(code, redirectUri);
  }

  getMe(portalToken: string) {
    return this.inner.getMe(portalToken);
  }

  async getProjectPermissions(portalToken: string, userId: string) {
    const key = `${userId}`;
    const hit = this.permCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await this.inner.getProjectPermissions(portalToken, userId);
    this.permCache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  async listRoles() {
    // Short TTL: the admin tool-access page polls frequently, but the portal
    // role list rarely changes, so cache to avoid hammering the portal.
    const rolesTtl = Math.min(this.ttlMs, 30_000);
    if (this.rolesCache && this.rolesCache.expiresAt > Date.now()) return this.rolesCache.value;
    const value = await this.inner.listRoles();
    this.rolesCache = { value, expiresAt: Date.now() + rolesTtl };
    return value;
  }

  listAllProjectPermissions(opts?: { cursor?: string; limit?: number; domain?: string }) {
    // No cache — admin sync should always hit the portal.
    return this.inner.listAllProjectPermissions(opts);
  }
}

import { MockPortalAdapter } from './mock.js';
import { RealPortalAdapter } from './real.js';
import { GooglePortalAdapter } from './google.js';
import { getIntegrationSetting, getIntegrationSettingOr } from '../config/integrationSettings.js';

export async function createPortalAdapter(): Promise<PortalAdapter> {
  const baseUrl = await getIntegrationSettingOr('portal_base_url', 'https://portal.rebus.industries');
  const apiKey = await getIntegrationSetting('portal_api_key');
  const mode = (await getIntegrationSettingOr('portal_adapter', 'mock')).toLowerCase();
  const ttlMs = Number(process.env.PORTAL_CACHE_TTL_MS ?? 300_000);
  const config: PortalAdapterConfig = { baseUrl, apiKey, cacheTtlMs: ttlMs };
  const inner =
    mode === 'google'
      ? new GooglePortalAdapter()
      : mode === 'real'
        ? new RealPortalAdapter(config)
        : new MockPortalAdapter(config);
  return new CachedPortalAdapter(inner, ttlMs);
}

export type { PortalProjectPermission };
