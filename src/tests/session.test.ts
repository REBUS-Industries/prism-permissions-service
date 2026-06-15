import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserSearchQuery } from '../orbit/client.js';
import { shouldProvisionOrbit } from '../access/session.js';

test('buildUserSearchQuery uses full email and rejects short strings', () => {
  assert.equal(buildUserSearchQuery('ed@rebus.industries'), 'ed@rebus.industries');
  assert.equal(buildUserSearchQuery('  Dom@Rebus.Industries '), 'dom@rebus.industries');
  assert.equal(buildUserSearchQuery('ab'), null);
});

test('shouldProvisionOrbit is false until admin assigns projects', () => {
  assert.equal(shouldProvisionOrbit([]), false);
  assert.equal(
    shouldProvisionOrbit([{ orbitProjectId: 'abc', level: 'viewer' }]),
    true,
  );
});
