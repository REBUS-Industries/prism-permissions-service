import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  CONNECTOR_FUNCTIONS,
  PRISM_TOOLS,
  type ConnectorFunction,
  type FunctionPolicyGraph,
  type PermissionsPolicyResponse,
  type ToolGrants,
  type ToolGrantsResponse,
} from '../contracts/portal-access.js';
import { requireAdmin } from '../auth/adminSession.js';
import { requirePermissionsEditor } from '../auth/permissionsEditor.js';
import { loadToolGrants, saveToolGrants } from '../access/tools.js';
import { getDb } from '../db/client.js';
import {
  functionPolicyEdges,
  functionPolicyNodes,
  policySettings,
} from '../db/schema.js';
import { loadPolicyGraph } from '../access/manifest.js';
import type { PortalAdapter } from '../portal/adapter.js';
import type { PortalRolesResponse } from '../contracts/portal-access.js';

export async function registerPermissionsRoutes(app: FastifyInstance, portal: PortalAdapter) {
  app.get('/api/permissions/tool-grants', { preHandler: requirePermissionsEditor }, async (): Promise<ToolGrantsResponse> => {
    const grants = await loadToolGrants();
    return { grants, updatedAt: new Date().toISOString() };
  });

  // Live feed of the portal's current role catalogue. The admin tool-access
  // page renders role nodes from this so deleted/renamed portal roles never
  // linger. Degrades to { supported: false } if the portal call fails or the
  // portal has not implemented GET /portal/roles yet.
  app.get('/api/permissions/portal-roles', { preHandler: requirePermissionsEditor }, async (): Promise<PortalRolesResponse> => {
    try {
      return await portal.listRoles();
    } catch (err) {
      app.log.warn({ err }, 'portal-roles fetch failed');
      return { roles: [], supported: false, fetchedAt: new Date().toISOString() };
    }
  });

  app.put<{ Body: { grants?: ToolGrants } }>(
    '/api/permissions/tool-grants',
    { preHandler: requirePermissionsEditor },
    async (req, reply) => {
      const grants = req.body?.grants;
      if (!grants?.roles) {
        return reply.status(400).send({ error: 'grants.roles required' });
      }
      await saveToolGrants({
        roles: grants.roles,
        users: grants.users ?? {},
      });
      return { grants: await loadToolGrants(), updatedAt: new Date().toISOString() };
    },
  );

  app.get('/api/permissions/tools', async () => ({ tools: PRISM_TOOLS }));

  await app.register(async (adminRoutes) => {
    adminRoutes.addHook('preHandler', requireAdmin);

    adminRoutes.get('/api/permissions/policy', async (): Promise<PermissionsPolicyResponse> => {
      const graph = await loadPolicyGraph();
      return {
        graph: {
          nodes: graph.nodes,
          edges: graph.edges,
          updatedAt: new Date().toISOString(),
        },
        defaultFunctions: graph.defaultFunctions,
      };
    });

    adminRoutes.put<{ Body: { graph?: FunctionPolicyGraph; defaultFunctions?: ConnectorFunction[] } }>(
      '/api/permissions/policy',
      async (req, reply) => {
        const body = req.body ?? {};
        const graph = body.graph;
        if (!graph?.nodes || !graph.edges) {
          return reply.status(400).send({ error: 'graph.nodes and graph.edges required' });
        }
        const db = getDb();
        const now = new Date();

        await db.delete(functionPolicyEdges);
        await db.delete(functionPolicyNodes);

        if (graph.nodes.length) {
          await db.insert(functionPolicyNodes).values(
            graph.nodes.map((n) => ({
              id: n.id,
              type: n.type,
              label: n.label,
              ref: n.ref ?? null,
              positionX: String(n.position.x),
              positionY: String(n.position.y),
              data: n.data ?? null,
              updatedAt: now,
            })),
          );
        }

        if (graph.edges.length) {
          await db.insert(functionPolicyEdges).values(
            graph.edges.map((e) => ({
              id: e.id || randomUUID(),
              sourceId: e.source,
              targetId: e.target,
              grant: e.grant !== false,
              updatedAt: now,
            })),
          );
        }

        const defaults = body.defaultFunctions ?? graph.nodes.length
          ? undefined
          : (['list_projects', 'list_models', 'list_versions', 'receive'] as ConnectorFunction[]);

        if (defaults) {
          await db
            .insert(policySettings)
            .values({ id: 'default', defaultFunctions: defaults, updatedAt: now })
            .onConflictDoUpdate({
              target: policySettings.id,
              set: { defaultFunctions: defaults, updatedAt: now },
            });
        }

        const saved = await loadPolicyGraph();
        return {
          graph: {
            nodes: saved.nodes,
            edges: saved.edges,
            updatedAt: now.toISOString(),
          },
          defaultFunctions: saved.defaultFunctions,
        };
      },
    );

    adminRoutes.get('/api/permissions/functions', async () => ({
      functions: CONNECTOR_FUNCTIONS,
    }));
  });
}
