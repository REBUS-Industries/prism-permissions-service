import { eq } from 'drizzle-orm';
import {
  CONNECTOR_FUNCTIONS,
  CONNECTOR_MANIFEST_SCHEMA,
  type ConnectorFunction,
  type ConnectorManifest,
  type ConnectorManifestProject,
  type PortalProjectPermission,
} from '../contracts/portal-access.js';
import { getDb } from '../db/client.js';
import {
  functionPolicyEdges,
  functionPolicyNodes,
  policySettings,
} from '../db/schema.js';

const LEVEL_FUNCTIONS: Record<string, ConnectorFunction[]> = {
  viewer: ['list_projects', 'list_models', 'list_versions', 'receive'],
  contributor: ['list_projects', 'list_models', 'list_versions', 'receive', 'send', 'create_version'],
  owner: [...CONNECTOR_FUNCTIONS],
  admin: [...CONNECTOR_FUNCTIONS],
};

export async function loadPolicyGraph() {
  const db = getDb();
  const [nodes, edges, settings] = await Promise.all([
    db.select().from(functionPolicyNodes),
    db.select().from(functionPolicyEdges),
    db.select().from(policySettings).where(eq(policySettings.id, 'default')).limit(1),
  ]);
  const defaultFunctions = (settings[0]?.defaultFunctions ?? LEVEL_FUNCTIONS.viewer) as ConnectorFunction[];
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as 'role' | 'user' | 'project' | 'function',
      label: n.label,
      ref: n.ref,
      position: { x: Number(n.positionX), y: Number(n.positionY) },
      data: (n.data as Record<string, unknown>) ?? undefined,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      grant: e.grant,
    })),
    defaultFunctions,
  };
}

function grantsFromGraph(
  graph: Awaited<ReturnType<typeof loadPolicyGraph>>,
  portalUser: { email: string },
  project: PortalProjectPermission,
  roleRefs: string[] = [],
): ConnectorFunction[] {
  const base = LEVEL_FUNCTIONS[project.level] ?? graph.defaultFunctions;
  const allowed = new Set<ConnectorFunction>(base);
  const normalizedRoles = new Set(roleRefs.map((r) => r.toLowerCase()));

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const functionNodes = graph.nodes.filter((n) => n.type === 'function');
  const principalNodes = graph.nodes.filter(
    (n) =>
      (n.type === 'user' && n.ref?.toLowerCase() === portalUser.email.toLowerCase()) ||
      (n.type === 'role' && n.ref && normalizedRoles.has(n.ref.toLowerCase())) ||
      (n.type === 'role' && n.ref === project.level) ||
      (n.type === 'project' && n.ref === project.orbitProjectId),
  );

  for (const edge of graph.edges) {
    if (!edge.grant) continue;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    if (target.type !== 'function' || !target.ref) continue;
    const fn = target.ref as ConnectorFunction;
    if (!CONNECTOR_FUNCTIONS.includes(fn)) continue;

    const sourceIsPrincipal = principalNodes.some((p) => p.id === source.id);
    const sourceIsProject = source.type === 'project' && source.ref === project.orbitProjectId;
    const targetIsFunction = functionNodes.some((f) => f.id === target.id);

    if (sourceIsPrincipal && targetIsFunction) allowed.add(fn);
    if (sourceIsProject && targetIsFunction && edge.source === source.id) allowed.add(fn);
  }

  return [...allowed].filter((f) => base.includes(f) || graph.defaultFunctions.includes(f));
}

export async function buildConnectorManifest(input: {
  sessionId: string;
  orbitTarget: 'prod' | 'dev';
  orbitServerUrl: string;
  orbitToken: string;
  expiresAt: Date;
  portalUser: { userId: string; email: string; displayName?: string | null };
  portalProjects: PortalProjectPermission[];
  roleRefs?: string[];
}): Promise<ConnectorManifest> {
  const graph = await loadPolicyGraph();
  const roleRefs = input.roleRefs ?? [];
  const projects: ConnectorManifestProject[] = input.portalProjects.map((p) => ({
    orbitProjectId: p.orbitProjectId,
    projectName: p.projectName,
    level: p.level,
    allowedFunctions: grantsFromGraph(graph, input.portalUser, p, roleRefs),
  }));

  return {
    schema: CONNECTOR_MANIFEST_SCHEMA,
    userId: input.portalUser.userId,
    email: input.portalUser.email,
    displayName: input.portalUser.displayName,
    orbitTarget: input.orbitTarget,
    orbitServerUrl: input.orbitServerUrl,
    orbitToken: input.orbitToken,
    expiresAt: input.expiresAt.toISOString(),
    sessionId: input.sessionId,
    projects,
    globalAllowedFunctions: graph.defaultFunctions,
  };
}

export function collectEffectiveFunctions(manifest: ConnectorManifest): ConnectorFunction[] {
  const set = new Set<ConnectorFunction>(manifest.globalAllowedFunctions);
  for (const p of manifest.projects) {
    for (const fn of p.allowedFunctions) set.add(fn);
  }
  return [...set];
}
