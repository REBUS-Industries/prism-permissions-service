/**
 * Reads PRISM integration settings from the shared `settings` table (same DB as
 * prism-server) with env fallbacks. Cached briefly to avoid per-field query storms.
 */
import { pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client.js';

const prismSettings = pgTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
});

/** Setting key → process.env fallback name. */
const ENV_MAP: Record<string, string> = {
  portal_adapter: 'PORTAL_ADAPTER',
  portal_base_url: 'PORTAL_BASE_URL',
  portal_api_key: 'PORTAL_API_KEY',
  portal_google_authorize_url: 'PORTAL_GOOGLE_AUTHORIZE_URL',
  portal_mock_persona: 'PORTAL_MOCK_PERSONA',
  portal_admin_emails: 'PORTAL_ADMIN_EMAILS',
  portal_admin_username: 'PORTAL_ADMIN_USERNAME',
  workspace_adapter: 'WORKSPACE_ADAPTER',
  workspace_domain: 'WORKSPACE_DOMAIN',
  workspace_admin_email: 'GOOGLE_WORKSPACE_ADMIN_EMAIL',
  workspace_enforce_provisioned: 'WORKSPACE_ENFORCE_PROVISIONED',
  google_oauth_client_id: 'GOOGLE_OAUTH_CLIENT_ID',
  google_oauth_client_secret: 'GOOGLE_OAUTH_CLIENT_SECRET',
  google_oauth_scopes: 'GOOGLE_OAUTH_SCOPES',
  google_service_account_json: 'GOOGLE_SERVICE_ACCOUNT_JSON',
  google_workspace_directory_refresh_token: 'GOOGLE_WORKSPACE_DIRECTORY_REFRESH_TOKEN',
};

const DEFAULTS: Record<string, string> = {
  portal_adapter: 'mock',
  portal_base_url: 'https://portal.rebus.industries',
  portal_mock_persona: 'alice',
  portal_admin_username: 'admin',
  workspace_adapter: 'mock',
  workspace_enforce_provisioned: '1',
  google_oauth_scopes: 'openid email profile',
};

let cache: Record<string, string> | null = null;
let cacheAt = 0;
const CACHE_MS = 15_000;

async function loadAll(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  const db = getDb();
  const rows = await db.select().from(prismSettings);
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  cache = out;
  cacheAt = now;
  return out;
}

export async function getIntegrationSetting(key: string): Promise<string | undefined> {
  const all = await loadAll();
  const dbVal = all[key]?.trim();
  if (dbVal) return dbVal;
  const envKey = ENV_MAP[key];
  const envVal = envKey ? process.env[envKey]?.trim() : undefined;
  if (envVal) return envVal;
  return DEFAULTS[key];
}

export async function getIntegrationSettingOr(key: string, fallback: string): Promise<string> {
  return (await getIntegrationSetting(key)) ?? fallback;
}
