import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  CONNECTOR_FUNCTIONS,
  type ConnectorFunction,
  type FunctionPolicyGraph,
  type PermissionsPolicyResponse,
} from '../contracts/portal-access.js';
import { requireAdmin } from '../auth/adminSession.js';
import { getDb } from '../db/client.js';
import {
  functionPolicyEdges,
  functionPolicyNodes,
  policySettings,
} from '../db/schema.js';
import { loadPolicyGraph } from '../access/manifest.js';

export async function registerPermissionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/permissions/policy', async (): Promise<PermissionsPolicyResponse> => {
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

  app.put<{ Body: { graph?: FunctionPolicyGraph; defaultFunctions?: ConnectorFunction[] } }>(
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

  app.get('/api/permissions/functions', async () => ({
    functions: CONNECTOR_FUNCTIONS,
  }));
}
