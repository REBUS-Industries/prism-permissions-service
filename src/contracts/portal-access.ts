/** Vendored copy of PRISM/shared/contracts/portal-access.ts for polyrepo build. */
export const PORTAL_ACCESS_SCHEMA = 'rebus/portal-access/v1' as const;
export const CONNECTOR_MANIFEST_SCHEMA = 'rebus/connector-manifest/v1' as const;

export type ConnectorFunction =
  | 'send'
  | 'receive'
  | 'list_projects'
  | 'list_models'
  | 'list_versions'
  /** @deprecated Never grantable — connector hard-denies project creation. Kept for reading legacy rows. */
  | 'create_project'
  | 'create_model'
  | 'create_version'
  | 'use_library'
  | 'use_infile';

/** Grantable connector functions (excludes create_project — connector never creates projects). */
export const CONNECTOR_FUNCTIONS: ConnectorFunction[] = [
  'send',
  'receive',
  'list_projects',
  'list_models',
  'list_versions',
  'create_model',
  'create_version',
  'use_library',
  'use_infile',
];

export type PortalProjectLevel = 'viewer' | 'contributor' | 'owner' | 'admin';

/** PRISM admin tools gated by role-based grants. */
export type PrismTool = 'convert' | 'visualiser' | 'fixtures' | 'materials' | 'models';

export const PRISM_TOOLS: PrismTool[] = ['convert', 'visualiser', 'fixtures', 'materials', 'models'];

/** Portal system role (from portal-app UserProfile.role). */
export type PortalSystemRole = 'superAdmin' | 'admin' | 'staff' | 'viewer';

export interface PortalUser {
  userId: string;
  email: string;
  googleSub?: string | null;
  displayName?: string | null;
  /**
   * The user's primary role id (portal `GET /portal/me.roleId`). Canonical key
   * matched against PortalRole.id and tool-grant keys.
   */
  roleId?: string | null;
  /** All role ids the user holds (portal `GET /portal/me.roleIds`). */
  roleIds?: string[] | null;
  /** @deprecated Legacy portal system role name; superseded by roleId. */
  role?: PortalSystemRole | string | null;
  /** @deprecated Legacy custom role id; superseded by roleId/roleIds. */
  customRoleId?: string | null;
}

/**
 * A role defined in the portal. The live source of truth for role ids; PRISM
 * mirrors it so deleted/renamed portal roles never linger as stale grants.
 */
export interface PortalRole {
  /** Canonical role id matched against PortalUser.role / customRoleId and tool-grant keys. */
  id: string;
  /** Human-readable label (defaults to id). */
  name?: string | null;
  /** True for built-in portal system roles (superAdmin / admin / staff / viewer). */
  system?: boolean;
}

/** GET /api/permissions/portal-roles — the portal's current role catalogue. */
export interface PortalRolesResponse {
  roles: PortalRole[];
  /** False when the portal has not implemented `GET /portal/roles` yet. */
  supported: boolean;
  fetchedAt: string;
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

/**
 * Exchange a portal OAuth code **or** a collaborator invite key for a
 * ConnectorManifest. Exactly one of `portalAuthCode` / `inviteKey` is required.
 * Codes of the form `invite:<key>` (from GET /api/access/invite-login) are
 * treated as invite keys.
 */
export interface AccessSessionRequest {
  portalAuthCode?: string;
  /** Collaborator login key (plaintext). Prefer this over encoding in portalAuthCode. */
  inviteKey?: string;
  orbitTarget?: 'prod' | 'dev';
  redirectUri?: string;
}

/**
 * Default invite-key function preset (send-only / "Light-like" UX).
 * Admins may grant any {@link CONNECTOR_FUNCTIONS} value, including `receive`,
 * `use_library`, and `use_infile`. Empty input falls back to this set.
 * `list_projects` is included so guests can see their assigned projects.
 * `create_project` is never grantable.
 */
export const LIGHT_CONNECTOR_FUNCTIONS: ConnectorFunction[] = [
  'send',
  'create_model',
  'create_version',
  'list_models',
  'list_versions',
  'list_projects',
];

/**
 * @deprecated Invite keys may now grant any connector function. Kept as an
 * empty list for back-compat imports; do not add denials here.
 */
export const INVITE_KEY_DENIED_FUNCTIONS: ConnectorFunction[] = [];

export type InviteKeyAuthMethod = 'portal' | 'invite_key';

/**
 * How a guest invite key may list/open models within its granted projects.
 * - `all` — every model in the granted projects
 * - `selected` — only `selectedModelIds`
 * - `authored` — only models whose Orbit property `userId` matches the
 *   invite session identity (`manifest.userId` = `invite:<keyId>`), i.e.
 *   models the guest uploaded with that author id baked in
 */
export type InviteModelAccess = 'all' | 'selected' | 'authored';

export const INVITE_MODEL_ACCESS_MODES: InviteModelAccess[] = ['all', 'selected', 'authored'];

/** Orbit model property used for authored-only filtering. */
export const INVITE_AUTHORED_MODEL_PROPERTY = 'userId' as const;

export interface InviteKeyProject {
  orbitProjectId: string;
  projectName?: string | null;
}

export interface CreateInviteKeyRequest {
  orbitProjectIds: string[];
  /** Defaults to LIGHT_CONNECTOR_FUNCTIONS. May include any ConnectorFunction. */
  allowedFunctions?: ConnectorFunction[];
  orbitTarget?: 'prod' | 'dev';
  expiresAt?: string | null;
  label?: string | null;
  /** Null/omit = unlimited. */
  maxRedemptions?: number | null;
  /** Optional display names keyed by project id (or parallel list via projects). */
  projectNames?: Record<string, string> | null;
  /** Defaults to `all`. */
  modelAccess?: InviteModelAccess;
  /** Required when modelAccess is `selected`. */
  selectedModelIds?: string[] | null;
}

export interface InviteKeyRecord {
  id: string;
  label?: string | null;
  orbitTarget: 'prod' | 'dev';
  projects: InviteKeyProject[];
  allowedFunctions: ConnectorFunction[];
  modelAccess: InviteModelAccess;
  selectedModelIds: string[];
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  redemptionCount: number;
  createdBy: string;
  createdAt: string;
  revokedAt?: string | null;
  lastRedeemedAt?: string | null;
  /** Plaintext key — present on create and on GET …/reveal (admin). */
  key?: string;
  /** Redeem URL — present with plaintext key. */
  redeemUrl?: string;
}

export interface CreateInviteKeyResponse {
  id: string;
  key: string;
  redeemUrl: string;
  expiresAt?: string | null;
  projects: InviteKeyProject[];
  allowedFunctions: ConnectorFunction[];
  label?: string | null;
  maxRedemptions?: number | null;
  modelAccess: InviteModelAccess;
  selectedModelIds: string[];
}

export interface UpdateInviteKeyRequest {
  label?: string | null;
  orbitProjectIds?: string[];
  projectNames?: Record<string, string> | null;
  allowedFunctions?: ConnectorFunction[];
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  modelAccess?: InviteModelAccess;
  selectedModelIds?: string[] | null;
}

export interface ListInviteKeysResponse {
  keys: InviteKeyRecord[];
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
  prismAccessToken: string;
  orbitBlanketAccess: boolean;
  projects: ConnectorManifestProject[];
  globalAllowedFunctions: ConnectorFunction[];
  /** How this session was authenticated. Omit/portal for Google/portal OAuth. */
  authMethod?: InviteKeyAuthMethod;
  /** Present when authMethod is invite_key — for audit / connector attribution. */
  inviteKeyId?: string;
  /**
   * Invite-key model visibility within granted projects.
   * Connector filters list_models / open using this (Orbit token is still project-scoped).
   */
  modelAccess?: InviteModelAccess;
  /** When modelAccess is `selected`. */
  selectedModelIds?: string[];
  /**
   * Orbit model property name for authored-only filter (`userId`).
   * Compare model[authoredProperty] / properties[authoredProperty] to `userId`.
   */
  authoredProperty?: typeof INVITE_AUTHORED_MODEL_PROPERTY;
}

export interface AccessSessionResponse {
  manifest: ConnectorManifest;
}

export type PolicyNodeType = 'role' | 'user' | 'project' | 'function' | 'tool';

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

export interface ToolGrants {
  roles: Record<string, PrismTool[]>;
  users?: Record<string, PrismTool[]>;
}

export interface ToolGrantsResponse {
  grants: ToolGrants;
  updatedAt?: string;
}

export interface EffectiveToolAccess {
  email: string;
  roles: string[];
  isPrismAdmin: boolean;
  tools: PrismTool[];
}

export interface ToolAuthorizeRequest {
  email: string;
  tool: PrismTool;
}

export interface ToolAuthorizeResponse {
  allowed: boolean;
  email: string;
  tool: PrismTool;
}

export interface PortalAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  cacheTtlMs: number;
}

export interface PortalAdapter {
  exchangeAuthCode(code: string, redirectUri?: string): Promise<string>;
  getMe(portalToken: string): Promise<PortalUser>;
  getProjectPermissions(portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse>;
  listRoles(): Promise<PortalRolesResponse>;
}

export type GoogleWorkspaceStatus = 'disconnected' | 'linked' | 'syncing';

export interface GoogleWorkspaceLink {
  id: string;
  domain: string;
  displayName?: string | null;
  status: GoogleWorkspaceStatus;
  adapter: string;
  linkedAt?: string | null;
  lastSyncAt?: string | null;
  userCount: number;
}

export type ProvisionedUserStatus = 'pending' | 'active' | 'suspended';
export type ProvisionedUserSource = 'manual' | 'workspace_sync';

export interface ProvisionedUser {
  id: string;
  email: string;
  displayName?: string | null;
  googleSub?: string | null;
  status: ProvisionedUserStatus;
  source: ProvisionedUserSource;
  isPrismAdmin: boolean;
  prismAdminUsername?: string | null;
  projectPermissions: PortalProjectPermission[];
  roleRefs: string[];
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSyncResult {
  linked: GoogleWorkspaceLink;
  imported: number;
  updated: number;
  unchanged: number;
}

export interface ProvisionedUserInput {
  email: string;
  displayName?: string | null;
  isPrismAdmin?: boolean;
  prismAdminUsername?: string | null;
  projectPermissions?: PortalProjectPermission[];
  roleRefs?: string[];
  status?: ProvisionedUserStatus;
}

export interface ProvisionedAdminCheck {
  allowed: boolean;
  prismAdminUsername?: string | null;
  email: string;
}
