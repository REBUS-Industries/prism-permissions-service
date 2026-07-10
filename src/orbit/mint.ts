import { randomUUID } from 'node:crypto';
import type { ConnectorFunction } from '../contracts/portal-access.js';
import {
  OrbitClientError,
  isRealOrbitUserId,
  type OrbitCreds,
  type OrbitTarget,
  getOrbitCreds,
} from './client.js';

export interface MintTokenInput {
  target: OrbitTarget;
  orbitUserId: string;
  email: string;
  projectIds: string[];
  functions: ConnectorFunction[];
  sessionId: string;
  lifespanSeconds?: number;
  /**
   * When true, never fall back to the admin PAT. Required for invite keys so
   * Orbit ACL (limitResources + scopes) is always enforced server-side.
   */
  forbidAdminFallback?: boolean;
}

export interface MintTokenResult {
  token: string;
  tokenId: string;
  expiresAt: Date;
  scopes: string[];
  projectIds: string[];
}

const FUNCTION_SCOPES: Record<ConnectorFunction, string[]> = {
  send: ['streams:write', 'objects:write'],
  receive: ['streams:read', 'objects:read'],
  list_projects: ['streams:read'],
  list_models: ['streams:read'],
  list_versions: ['streams:read', 'objects:read'],
  create_project: ['streams:write', 'users:read'],
  create_model: ['streams:write'],
  create_version: ['streams:write', 'objects:write'],
};

export function functionsToScopes(functions: ConnectorFunction[]): string[] {
  const scopes = new Set<string>();
  for (const fn of functions) {
    for (const s of FUNCTION_SCOPES[fn]) scopes.add(s);
  }
  return [...scopes].sort();
}

/**
 * Mint a scoped ORBIT personal access token for connector use.
 * Uses Speckle apiTokenCreate when available; falls back to admin delegation token
 * (server still enforces project ACL via user's existing access when using user token).
 */
export async function mintScopedOrbitToken(input: MintTokenInput): Promise<MintTokenResult> {
  const creds = getOrbitCreds(input.target);
  const scopes = functionsToScopes(input.functions);
  const lifespan = input.lifespanSeconds ?? Number(process.env.ORBIT_TOKEN_LIFESPAN_SEC ?? 86400);
  const expiresAt = new Date(Date.now() + lifespan * 1000);
  const tokenId = randomUUID();
  const name = `prism-portal:${input.email}:${input.sessionId.slice(0, 8)}`;
  // Never send synthetic portal:/invite: ids — apiTokenCreate rejects them and
  // invite sessions previously returned an empty orbitToken as a result.
  const userId = isRealOrbitUserId(input.orbitUserId) ? input.orbitUserId : undefined;

  try {
    const data = await gqlMint(creds, {
      name,
      scopes,
      lifespan,
      projectIds: input.projectIds,
      userId,
    });
    return {
      token: data.token,
      tokenId,
      expiresAt,
      scopes,
      projectIds: input.projectIds,
    };
  } catch (err) {
    if (input.forbidAdminFallback || process.env.ORBIT_MINT_FALLBACK === '0') throw err;
    // Fallback: return admin token — manifest still gates UI for portal users.
    // Invite keys must set forbidAdminFallback so Orbit ACL is never bypassed.
    // Production should enable apiTokenCreate on orbit-server or set ORBIT_MINT_FALLBACK=0.
    return {
      token: creds.token,
      tokenId,
      expiresAt,
      scopes,
      projectIds: input.projectIds,
    };
  }
}

async function gqlMint(
  creds: OrbitCreds,
  input: {
    name: string;
    scopes: string[];
    lifespan: number;
    projectIds: string[];
    userId?: string;
  },
): Promise<{ id: string; token: string }> {
  const token: Record<string, unknown> = {
    name: input.name,
    scopes: input.scopes,
    lifespan: input.lifespan,
  };
  if (input.projectIds.length > 0) {
    token.limitResources = input.projectIds.map((id) => ({ id, type: 'project' }));
  }
  // Omit userId to mint for the authenticated admin (service principal).
  if (input.userId) token.userId = input.userId;

  // Orbit/Speckle: apiTokenCreate returns String! (the raw token), not an object.
  const res = await fetch(`${creds.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify({
      query: `mutation($token: ApiTokenCreateInput!) {
        apiTokenCreate(token: $token)
      }`,
      variables: { token },
    }),
  });
  const body = (await res.json()) as {
    data?: { apiTokenCreate?: string | { id?: string; token?: string } | null };
    errors?: { message: string }[];
  };
  if (!res.ok || body.errors?.length) {
    throw new OrbitClientError(
      res.status,
      body.errors?.[0]?.message ?? 'apiTokenCreate unavailable',
      body.errors,
    );
  }

  const created = body.data?.apiTokenCreate;
  const tokenValue =
    typeof created === 'string'
      ? created
      : created && typeof created === 'object'
        ? created.token
        : undefined;
  if (!tokenValue) {
    throw new OrbitClientError(res.status, 'apiTokenCreate returned empty token', body);
  }
  const id =
    typeof created === 'object' && created?.id ? created.id : randomUUID();
  return { id, token: tokenValue };
}
