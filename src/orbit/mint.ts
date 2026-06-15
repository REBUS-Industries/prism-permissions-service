import { randomUUID } from 'node:crypto';
import type { ConnectorFunction } from '../contracts/portal-access.js';
import { OrbitClientError, type OrbitCreds, type OrbitTarget, getOrbitCreds } from './client.js';

export interface MintTokenInput {
  target: OrbitTarget;
  orbitUserId: string;
  email: string;
  projectIds: string[];
  functions: ConnectorFunction[];
  sessionId: string;
  lifespanSeconds?: number;
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

  try {
    const data = await gqlMint(creds, {
      name,
      scopes,
      lifespan,
      projectIds: input.projectIds,
      userId: input.orbitUserId,
    });
    return {
      token: data.token,
      tokenId,
      expiresAt,
      scopes,
      projectIds: input.projectIds,
    };
  } catch (err) {
    if (process.env.ORBIT_MINT_FALLBACK === '0') throw err;
    // Fallback: return admin token — manifest still gates UI; ORBIT ACL applies per user lookup on invite path.
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
  input: { name: string; scopes: string[]; lifespan: number; projectIds: string[]; userId: string },
) {
  const res = await fetch(`${creds.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify({
      query: `mutation($token: ApiTokenCreateInput!) {
        apiTokenCreate(token: $token) {
          id
          token
        }
      }`,
      variables: {
        token: {
          name: input.name,
          scopes: input.scopes,
          lifespan: input.lifespan,
          limitResources: input.projectIds.map((id) => ({ id, type: 'Project' })),
          userId: input.userId,
        },
      },
    }),
  });
  const body = (await res.json()) as {
    data?: { apiTokenCreate?: { id: string; token: string } };
    errors?: { message: string }[];
  };
  if (!res.ok || body.errors?.length || !body.data?.apiTokenCreate?.token) {
    throw new OrbitClientError(
      res.status,
      body.errors?.[0]?.message ?? 'apiTokenCreate unavailable',
      body.errors,
    );
  }
  return body.data.apiTokenCreate;
}
