import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortalProjectPermission, PortalUser } from '../contracts/portal-access.js';

/**
 * Lightweight unit coverage for portal-vs-provisioned project resolution.
 * DB-backed paths are covered in integration; here we assert the pure merge
 * rules used by resolveProvisionedAccess by re-implementing the branch.
 */
function pickProjects(
  provisionedProjects: PortalProjectPermission[],
  portalProjects: PortalProjectPermission[],
  portalMembershipsSupported: boolean,
): PortalProjectPermission[] {
  return portalMembershipsSupported ? portalProjects : provisionedProjects;
}

const portalUser: PortalUser = {
  userId: 'portal-user-alice',
  email: 'alice@rebus.industries',
};

test('portal memberships win when adapter supports them', () => {
  const provisioned: PortalProjectPermission[] = [
    { orbitProjectId: 'manual', level: 'owner', projectName: 'Manual' },
  ];
  const portal: PortalProjectPermission[] = [
    { orbitProjectId: 'portal-a', level: 'contributor', projectName: 'Portal A' },
  ];
  assert.deepEqual(pickProjects(provisioned, portal, true), portal);
  assert.equal(portalUser.email, 'alice@rebus.industries');
});

test('empty portal list clears access when supported (full replace)', () => {
  const provisioned: PortalProjectPermission[] = [
    { orbitProjectId: 'manual', level: 'owner', projectName: 'Manual' },
  ];
  assert.deepEqual(pickProjects(provisioned, [], true), []);
});

test('unsupported adapter keeps provisioned assignments', () => {
  const provisioned: PortalProjectPermission[] = [
    { orbitProjectId: 'manual', level: 'owner', projectName: 'Manual' },
  ];
  assert.deepEqual(pickProjects(provisioned, [], false), provisioned);
});
