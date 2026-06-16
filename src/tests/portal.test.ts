import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPortalAdapter } from '../portal/mock.js';
import { RealPortalAdapter } from '../portal/real.js';
import { functionsToScopes } from '../orbit/mint.js';

test('MockPortalAdapter exchanges mock:alice code', async () => {
  const adapter = new MockPortalAdapter({ baseUrl: 'http://mock', apiKey: '', cacheTtlMs: 0 });
  const token = await adapter.exchangeAuthCode('mock:alice');
  assert.ok(token.startsWith('mock-portal-token:'));
  const me = await adapter.getMe(token);
  assert.equal(me.email, 'alice@rebus.industries');
  const perms = await adapter.getProjectPermissions(token, me.userId);
  assert.ok(perms.projects.length >= 1);
});

test('RealPortalAdapter sends user token to /portal/me, not service key', async () => {
  const calls: { url: string; authorization?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url: String(input), authorization: headers?.authorization });
    if (String(input).endsWith('/portal/me')) {
      return new Response(JSON.stringify({ userId: 'portal-user-1', email: 'alice@rebus.industries' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const adapter = new RealPortalAdapter({
      baseUrl: 'https://portal.example',
      apiKey: 'service-key-should-not-be-used',
      cacheTtlMs: 0,
    });
    await adapter.getMe('user-portal-token');
    const meCall = calls.find((c) => c.url.endsWith('/portal/me'));
    assert.equal(meCall?.authorization, 'Bearer user-portal-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('functionsToScopes maps send/receive', () => {
  const scopes = functionsToScopes(['send', 'receive', 'list_projects']);
  assert.ok(scopes.includes('streams:write'));
  assert.ok(scopes.includes('streams:read'));
});
