import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserSearchQuery, isRealOrbitUserId } from '../orbit/client.js';
import { useBlanketOrbitAccess } from '../access/session.js';
import { collectEffectiveFunctions } from '../access/manifest.js';
import { CONNECTOR_FUNCTIONS, CONNECTOR_MANIFEST_SCHEMA } from '../contracts/portal-access.js';

test('buildUserSearchQuery uses full email and rejects short strings', () => {
  assert.equal(buildUserSearchQuery('ed@rebus.industries'), 'ed@rebus.industries');
  assert.equal(buildUserSearchQuery('  Dom@Rebus.Industries '), 'dom@rebus.industries');
  assert.equal(buildUserSearchQuery('ab'), null);
});

test('isRealOrbitUserId rejects synthetic portal/invite placeholders', () => {
  assert.equal(isRealOrbitUserId('portal:invite:abc'), false);
  assert.equal(isRealOrbitUserId('invite:abc'), false);
  assert.equal(isRealOrbitUserId(''), false);
  assert.equal(isRealOrbitUserId(null), false);
  assert.equal(isRealOrbitUserId('a1b2c3d4e5'), true);
});

test('orbitMintScopeHint explains tokens:write remediation', async () => {
  const { orbitMintScopeHint } = await import('../orbit/client.js');
  const hinted = orbitMintScopeHint('Your auth token does not have the required scope: tokens:write.');
  assert.match(hinted, /ORBIT_MINT_TOKEN/);
  assert.match(hinted, /tokens:write/);
  assert.equal(orbitMintScopeHint('other error'), 'other error');
});

test('useBlanketOrbitAccess defaults to true; env kill-switch forces per-project', async () => {
  const prev = process.env.ORBIT_BLANKET_ACCESS;
  delete process.env.ORBIT_BLANKET_ACCESS;
  // Settings DB is unavailable in tests → falls back to blanket on (default).
  assert.equal(await useBlanketOrbitAccess([]), true);
  assert.equal(
    await useBlanketOrbitAccess([{ orbitProjectId: 'abc', level: 'viewer' }]),
    true,
  );
  process.env.ORBIT_BLANKET_ACCESS = '0';
  assert.equal(await useBlanketOrbitAccess([]), true);
  assert.equal(
    await useBlanketOrbitAccess([{ orbitProjectId: 'abc', level: 'viewer' }]),
    false,
  );
  if (prev === undefined) delete process.env.ORBIT_BLANKET_ACCESS;
  else process.env.ORBIT_BLANKET_ACCESS = prev;
});

test('collectEffectiveFunctions grants all connector ops under blanket access', () => {
  const fns = collectEffectiveFunctions({
    schema: CONNECTOR_MANIFEST_SCHEMA,
    userId: 'u1',
    email: 'alice@rebus.industries',
    orbitTarget: 'dev',
    orbitServerUrl: 'https://orbit-dev.example',
    orbitToken: 'tok',
    expiresAt: new Date().toISOString(),
    sessionId: 'sess',
    prismAccessToken: 'sess',
    orbitBlanketAccess: true,
    projects: [],
    globalAllowedFunctions: [...CONNECTOR_FUNCTIONS],
  });
  assert.deepEqual(fns.sort(), [...CONNECTOR_FUNCTIONS].sort());
});
