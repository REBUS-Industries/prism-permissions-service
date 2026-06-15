export type OrbitTarget = 'prod' | 'dev';

export interface OrbitCreds {
  url: string;
  token: string;
}

export function getOrbitCreds(target: OrbitTarget): OrbitCreds {
  const url =
    target === 'dev'
      ? (process.env.ORBIT_DEV_SERVER_URL ?? process.env.ORBIT_SERVER_URL ?? '')
      : (process.env.ORBIT_SERVER_URL ?? '');
  const token =
    target === 'dev'
      ? (process.env.ORBIT_DEV_ADMIN_TOKEN || process.env.ORBIT_ADMIN_TOKEN || '')
      : (process.env.ORBIT_ADMIN_TOKEN || '');
  if (!url || !token) {
    throw new Error(`ORBIT admin credentials missing for target=${target}`);
  }
  return { url: url.replace(/\/+$/, ''), token };
}

export class OrbitClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'OrbitClientError';
  }
}

async function gql<T>(creds: OrbitCreds, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${creds.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) {
    throw new OrbitClientError(
      res.status,
      body.errors?.[0]?.message ?? `GraphQL request failed (${res.status})`,
      body.errors,
    );
  }
  return body.data as T;
}

export async function findOrbitUserByEmail(creds: OrbitCreds, email: string) {
  const data = await gql<{ userSearch: { items: { id: string; name: string; email: string }[] } }>(
    creds,
    `query($query: String!) {
      userSearch(query: $query, limit: 5) {
        items { id name email }
      }
    }`,
    { query: email },
  );
  const match = data.userSearch.items.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  return match ?? null;
}

export async function inviteOrbitUser(creds: OrbitCreds, email: string, name: string) {
  const data = await gql<{ serverInviteCreate: boolean }>(
    creds,
    `mutation($input: ServerInviteCreateInput!) {
      serverInviteCreate(input: $input)
    }`,
    { input: { email, message: 'Invited via PRISM permissions service' } },
  );
  if (!data.serverInviteCreate) throw new OrbitClientError(500, 'Failed to invite ORBIT user');
  return findOrbitUserByEmail(creds, email);
}
