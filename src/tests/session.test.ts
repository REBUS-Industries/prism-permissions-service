import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserSearchQuery } from '../orbit/client.js';
import { useBlanketOrbitAccess } from '../access/session.js';
import { collectEffectiveFunctions } from '../access/manifest.js';
import { CONNECTOR_FUNCTIONS, CONNECTOR_MANIFEST_SCHEMA } from '../contracts/portal-access.js';

test('buildUserSearchQuery uses full email and rejects short strings', () => {
  assert.equal(buildUserSearchQuery('ed@rebus.industries'), 'ed@rebus.industries');
  assert.equal(buildUserSearchQuery('  Dom@Rebus.Industries '), 'dom@rebus.industries');
  assert.equal(buildUserSearchQuery('ab'), null);
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
