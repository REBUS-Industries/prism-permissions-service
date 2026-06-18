import {
  PORTAL_ACCESS_SCHEMA,
  type PortalProjectPermissionsResponse,
  type PortalRolesResponse,
  type PortalUser,
} from '../contracts/portal-access.js';
import type { PortalAdapter, PortalAdapterConfig } from './adapter.js';

const MOCK_USERS: Record<string, PortalUser> = {
  'mock:alice': {
    userId: 'portal-user-alice',
    email: 'alice@rebus.industries',
    googleSub: 'google-sub-alice',
    displayName: 'Alice Dev',
    roleId: 'staff',
    roleIds: ['staff'],
    role: 'staff',
  },
  'mock:bob': {
    userId: 'portal-user-bob',
    email: 'bob@rebus.industries',
    googleSub: 'google-sub-bob',
    displayName: 'Bob Viewer',
    roleId: 'viewer',
    roleIds: ['viewer'],
    role: 'viewer',
  },
};

const MOCK_PROJECTS: Record<string, PortalProjectPermissionsResponse> = {
  'portal-user-alice': {
    schema: PORTAL_ACCESS_SCHEMA,
    userId: 'portal-user-alice',
    fetchedAt: new Date().toISOString(),
    projects: [
      { orbitProjectId: 'mock-project-1', level: 'contributor', projectName: 'Demo Project A' },
      { orbitProjectId: 'mock-project-2', level: 'owner', projectName: 'Demo Project B' },
    ],
  },
  'portal-user-bob': {
    schema: PORTAL_ACCESS_SCHEMA,
    userId: 'portal-user-bob',
    fetchedAt: new Date().toISOString(),
    projects: [{ orbitProjectId: 'mock-project-1', level: 'viewer', projectName: 'Demo Project A' }],
  },
};

export class MockPortalAdapter implements PortalAdapter {
  constructor(_config: PortalAdapterConfig) {}

  async exchangeAuthCode(code: string): Promise<string> {
    if (!code.startsWith('mock:')) {
      throw new Error('Mock portal expects portalAuthCode like mock:alice or mock:bob');
    }
    return `mock-portal-token:${code}`;
  }

  async getMe(portalToken: string): Promise<PortalUser> {
    const code = portalToken.replace(/^mock-portal-token:/, '');
    const user = MOCK_USERS[code];
    if (!user) throw new Error(`Unknown mock portal token: ${portalToken}`);
    return user;
  }

  async getProjectPermissions(_portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse> {
    const projects = MOCK_PROJECTS[userId];
    if (!projects) {
      return {
        schema: PORTAL_ACCESS_SCHEMA,
        userId,
        projects: [],
        fetchedAt: new Date().toISOString(),
      };
    }
    return { ...projects, fetchedAt: new Date().toISOString() };
  }

  async listRoles(): Promise<PortalRolesResponse> {
    // Ids mirror the real portal convention (super-admin = SUPER_ADMIN_ROLE_ID).
    return {
      roles: [
        { id: 'super-admin', name: 'Super Admin', system: true },
        { id: 'admin', name: 'Admin', system: true },
        { id: 'staff', name: 'Staff', system: true },
        { id: 'viewer', name: 'Viewer', system: true },
      ],
      supported: true,
      fetchedAt: new Date().toISOString(),
    };
  }
}
