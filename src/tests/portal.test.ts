import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPortalAdapter } from '../portal/mock.js';
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

test('functionsToScopes maps send/receive', () => {
  const scopes = functionsToScopes(['send', 'receive', 'list_projects']);
  assert.ok(scopes.includes('streams:write'));
  assert.ok(scopes.includes('streams:read'));
});
