import { JWT } from 'google-auth-library';
import { getIntegrationSetting } from '../config/integrationSettings.js';
import type { WorkspaceDirectoryUser } from './mockDirectory.js';

const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

interface GoogleDirectoryUser {
  id?: string;
  primaryEmail?: string;
  name?: { fullName?: string };
  suspended?: boolean;
}

interface GoogleDirectoryListResponse {
  users?: GoogleDirectoryUser[];
  nextPageToken?: string;
}

export async function listGoogleWorkspaceDirectory(domain: string): Promise<WorkspaceDirectoryUser[]> {
  const saJson = await getIntegrationSetting('google_service_account_json');
  const adminEmail = await getIntegrationSetting('workspace_admin_email');
  if (!saJson) {
    throw new Error('google_service_account_json is not configured in Settings');
  }
  if (!adminEmail) {
    throw new Error('workspace_admin_email is not configured — set the admin user to impersonate for directory sync');
  }

  let credentials: { client_email?: string; private_key?: string };
  try {
    credentials = JSON.parse(saJson) as { client_email?: string; private_key?: string };
  } catch {
    throw new Error('google_service_account_json is not valid JSON');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Service account JSON must include client_email and private_key');
  }

  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [DIRECTORY_SCOPE],
    subject: adminEmail,
  });

  const normalizedDomain = domain.trim().toLowerCase();
  const out: WorkspaceDirectoryUser[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://admin.googleapis.com/admin/directory/v1/users');
    url.searchParams.set('domain', normalizedDomain);
    url.searchParams.set('maxResults', '500');
    url.searchParams.set('orderBy', 'email');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const token = await auth.getAccessToken();
    if (!token) throw new Error('Failed to obtain Google Admin SDK access token');

    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Google Directory API failed (${res.status}): ${detail}`);
    }

    const body = (await res.json()) as GoogleDirectoryListResponse;
    for (const user of body.users ?? []) {
      const email = user.primaryEmail?.trim().toLowerCase();
      if (!email) continue;
      out.push({
        email,
        displayName: user.name?.fullName?.trim() || email.split('@')[0] || email,
        googleSub: user.id,
        suspended: user.suspended === true,
      });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return out;
}
