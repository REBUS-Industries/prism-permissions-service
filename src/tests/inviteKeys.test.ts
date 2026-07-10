import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInviteKeyFromSessionRequest,
  normalizeInviteFunctions,
  normalizeModelAccess,
} from '../access/inviteKeys.js';
import { AccessError } from '../access/errors.js';
import { collectEffectiveFunctions } from '../access/manifest.js';
import {
  CONNECTOR_MANIFEST_SCHEMA,
  INVITE_AUTHORED_MODEL_PROPERTY,
  LIGHT_CONNECTOR_FUNCTIONS,
} from '../contracts/portal-access.js';
import { functionsToScopes } from '../orbit/mint.js';

test('normalizeInviteFunctions defaults to Light set', () => {
  assert.deepEqual(normalizeInviteFunctions(undefined), [...LIGHT_CONNECTOR_FUNCTIONS]);
  assert.deepEqual(normalizeInviteFunctions([]), [...LIGHT_CONNECTOR_FUNCTIONS]);
});

test('normalizeInviteFunctions rejects receive and create_project', () => {
  assert.throws(
    () => normalizeInviteFunctions(['send', 'receive']),
    (err: unknown) => err instanceof AccessError && /receive/.test((err as Error).message),
  );
  assert.throws(
    () => normalizeInviteFunctions(['create_project']),
    (err: unknown) => err instanceof AccessError && /create_project/.test((err as Error).message),
  );
});

test('extractInviteKeyFromSessionRequest prefers inviteKey field', () => {
  assert.equal(
    extractInviteKeyFromSessionRequest({ inviteKey: ' invite_abc ', portalAuthCode: 'mock:alice' }),
    'invite_abc',
  );
  assert.equal(
    extractInviteKeyFromSessionRequest({ portalAuthCode: 'invite:invite_xyz' }),
    'invite_xyz',
  );
  assert.equal(extractInviteKeyFromSessionRequest({ portalAuthCode: 'mock:alice' }), null);
  assert.equal(extractInviteKeyFromSessionRequest({}), null);
});

test('invite-key style manifest never blankets and excludes receive', () => {
  const allowed = ['send', 'create_model', 'create_version', 'list_models'] as const;
  const manifest = {
    schema: CONNECTOR_MANIFEST_SCHEMA,
    userId: 'invite:demo',
    email: 'invite+demo@invite.prism.local',
    orbitTarget: 'dev' as const,
    orbitServerUrl: 'https://orbit-dev.example',
    orbitToken: 'tok',
    expiresAt: new Date().toISOString(),
    sessionId: 'sess',
    prismAccessToken: 'sess',
    orbitBlanketAccess: false,
    authMethod: 'invite_key' as const,
    inviteKeyId: 'invite-demo-light',
    projects: [
      {
        orbitProjectId: 'mock-project-1',
        projectName: 'Demo Project A',
        level: 'contributor' as const,
        allowedFunctions: [...allowed],
      },
    ],
    globalAllowedFunctions: [],
  };
  assert.equal(manifest.orbitBlanketAccess, false);
  const fns = collectEffectiveFunctions(manifest);
  assert.ok(fns.includes('send'));
  assert.ok(fns.includes('create_model'));
  assert.ok(!fns.includes('receive'));
  assert.ok(!fns.includes('create_project'));
  assert.deepEqual(
    manifest.projects.map((p) => p.orbitProjectId),
    ['mock-project-1'],
  );
});

test('Light functions mint write scopes without requiring receive', () => {
  const scopes = functionsToScopes([...LIGHT_CONNECTOR_FUNCTIONS]);
  assert.ok(scopes.includes('streams:write'));
  assert.ok(scopes.includes('objects:write'));
  // list_versions currently maps to objects:read at Orbit scope level;
  // project limitResources still restricts which streams are reachable.
  assert.ok(scopes.includes('streams:read'));
});

test('normalizeModelAccess defaults to all', () => {
  assert.deepEqual(normalizeModelAccess(undefined, undefined), {
    modelAccess: 'all',
    selectedModelIds: [],
  });
  assert.deepEqual(normalizeModelAccess('authored', ['m1']), {
    modelAccess: 'authored',
    selectedModelIds: [],
  });
});

test('normalizeModelAccess requires selectedModelIds for selected', () => {
  assert.throws(
    () => normalizeModelAccess('selected', []),
    (err: unknown) => err instanceof AccessError && /selectedModelIds/.test((err as Error).message),
  );
  assert.deepEqual(normalizeModelAccess('selected', [' m1 ', 'm1', 'm2']), {
    modelAccess: 'selected',
    selectedModelIds: ['m1', 'm2'],
  });
});

test('normalizeModelAccess rejects unknown modes', () => {
  assert.throws(
    () => normalizeModelAccess('bogus' as 'all', null),
    (err: unknown) => err instanceof AccessError && /modelAccess/.test((err as Error).message),
  );
});

test('authored filter property is userId', () => {
  assert.equal(INVITE_AUTHORED_MODEL_PROPERTY, 'userId');
});

test('invite-key manifest carries modelAccess fields', () => {
  const manifest = {
    schema: CONNECTOR_MANIFEST_SCHEMA,
    userId: 'invite:demo',
    email: 'invite+demo@invite.prism.local',
    orbitTarget: 'dev' as const,
    orbitServerUrl: 'https://orbit-dev.example',
    orbitToken: 'tok',
    expiresAt: new Date().toISOString(),
    sessionId: 'sess',
    prismAccessToken: 'sess',
    orbitBlanketAccess: false,
    authMethod: 'invite_key' as const,
    inviteKeyId: 'invite-demo-light',
    modelAccess: 'authored' as const,
    selectedModelIds: [] as string[],
    authoredProperty: INVITE_AUTHORED_MODEL_PROPERTY,
    projects: [
      {
        orbitProjectId: 'mock-project-1',
        projectName: 'Demo Project A',
        level: 'contributor' as const,
        allowedFunctions: [...LIGHT_CONNECTOR_FUNCTIONS],
      },
    ],
    globalAllowedFunctions: [],
  };
  assert.equal(manifest.modelAccess, 'authored');
  assert.equal(manifest.authoredProperty, 'userId');
  assert.equal(manifest.userId, 'invite:demo');
});
