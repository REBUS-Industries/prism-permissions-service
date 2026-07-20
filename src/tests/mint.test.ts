import test from 'node:test';
import assert from 'node:assert/strict';
import { functionsToScopes } from '../orbit/mint.js';
import { CONNECTOR_FUNCTIONS, LIGHT_CONNECTOR_FUNCTIONS } from '../contracts/portal-access.js';

test('functionsToScopes maps send/receive', () => {
  assert.deepEqual(functionsToScopes(['send']).sort(), ['objects:write', 'streams:write']);
  assert.deepEqual(functionsToScopes(['receive']).sort(), ['objects:read', 'streams:read']);
  assert.ok(functionsToScopes([...CONNECTOR_FUNCTIONS]).includes('streams:write'));
});

test('Light functions mint write scopes without requiring receive', () => {
  const scopes = functionsToScopes([...LIGHT_CONNECTOR_FUNCTIONS]);
  assert.ok(scopes.includes('streams:write'));
  assert.ok(scopes.includes('objects:write'));
  assert.ok(scopes.includes('streams:read'));
});

test('use_library / use_infile mint read scopes like receive', () => {
  assert.deepEqual(functionsToScopes(['use_library']).sort(), ['objects:read', 'streams:read']);
  assert.deepEqual(functionsToScopes(['use_infile']).sort(), ['objects:read', 'streams:read']);
});

test('use_file_library mints no Orbit scopes (Prism /api/files)', () => {
  assert.deepEqual(functionsToScopes(['use_file_library']), []);
});

/** Documents Orbit schema: apiTokenCreate returns String!, not { id token }. */
test('apiTokenCreate response parsing accepts raw string token', () => {
  const parse = (created: string | { id?: string; token?: string } | null | undefined) =>
    typeof created === 'string'
      ? created
      : created && typeof created === 'object'
        ? created.token
        : undefined;
  assert.equal(parse('orbit-pat-abc123'), 'orbit-pat-abc123');
  assert.equal(parse({ id: '1', token: 'tok' }), 'tok');
  assert.equal(parse(null), undefined);
});
