/** Vendored copy of PRISM/shared/contracts/portal-access.ts for polyrepo build. */
export const PORTAL_ACCESS_SCHEMA = 'rebus/portal-access/v1' as const;
export const CONNECTOR_MANIFEST_SCHEMA = 'rebus/connector-manifest/v1' as const;

export type ConnectorFunction =
  | 'send'
  | 'receive'
  | 'list_projects'
  | 'list_models'
  | 'list_versions'
  | 'create_project'
  | 'create_model'
  | 'create_version';

export const CONNECTOR_FUNCTIONS: ConnectorFunction[] = [
  'send',
  'receive',
  'list_projects',
  'list_models',
  'list_versions',
  'create_project',
  'create_model',
  'create_version',
];

export type PortalProjectLevel = 'viewer' | 'contributor' | 'owner' | 'admin';

export interface PortalUser {
  userId: string;
  email: string;
  googleSub?: string | null;
  displayName?: string | null;
}

export interface PortalProjectPermission {
  orbitProjectId: string;
  level: PortalProjectLevel;
  projectName?: string | null;
}

export interface PortalProjectPermissionsResponse {
  schema: typeof PORTAL_ACCESS_SCHEMA;
  userId: string;
  projects: PortalProjectPermission[];
  fetchedAt: string;
}

export interface AccessSessionRequest {
  portalAuthCode: string;
  orbitTarget?: 'prod' | 'dev';
  redirectUri?: string;
}

export interface ConnectorManifestProject {
  orbitProjectId: string;
  projectName?: string | null;
  level: PortalProjectLevel;
  allowedFunctions: ConnectorFunction[];
}

export interface ConnectorManifest {
  schema: typeof CONNECTOR_MANIFEST_SCHEMA;
  userId: string;
  email: string;
  displayName?: string | null;
  orbitTarget: 'prod' | 'dev';
  orbitServerUrl: string;
  orbitToken: string;
  expiresAt: string;
  sessionId: string;
  projects: ConnectorManifestProject[];
  globalAllowedFunctions: ConnectorFunction[];
}

export interface AccessSessionResponse {
  manifest: ConnectorManifest;
}

export type PolicyNodeType = 'role' | 'user' | 'project' | 'function';

export interface PolicyNode {
  id: string;
  type: PolicyNodeType;
  label: string;
  ref?: string | null;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface PolicyEdge {
  id: string;
  source: string;
  target: string;
  grant?: boolean;
}

export interface FunctionPolicyGraph {
  nodes: PolicyNode[];
  edges: PolicyEdge[];
  updatedAt?: string;
}

export interface PermissionsPolicyResponse {
  graph: FunctionPolicyGraph;
  defaultFunctions: ConnectorFunction[];
}
