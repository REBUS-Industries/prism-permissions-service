import type { FastifyInstance } from 'fastify';
import type { ProvisionedUserInput } from '../contracts/portal-access.js';
import { requireAdmin } from '../auth/adminSession.js';
import {
  createProvisionedUser,
  deleteProvisionedUser,
  getWorkspaceLink,
  linkGoogleWorkspace,
  listProvisionedUsers,
  syncWorkspaceDirectory,
  unlinkGoogleWorkspace,
  updateProvisionedUser,
} from '../workspace/service.js';

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  await app.register(async (adminRoutes) => {
    adminRoutes.addHook('preHandler', requireAdmin);

    adminRoutes.get('/api/permissions/workspace', async (_req, reply) => {
      const workspace = await getWorkspaceLink();
      return { workspace, users: await listProvisionedUsers() };
    });

    adminRoutes.post<{ Body: { domain?: string; displayName?: string } }>(
      '/api/permissions/workspace/link',
      async (req, reply) => {
        const domain = req.body?.domain?.trim();
        if (!domain) return reply.status(400).send({ error: 'domain required' });
        try {
          const workspace = await linkGoogleWorkspace(domain, req.body?.displayName?.trim());
          return { workspace };
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Link failed' });
        }
      },
    );

    adminRoutes.post('/api/permissions/workspace/unlink', async () => {
      await unlinkGoogleWorkspace();
      return { ok: true };
    });

    adminRoutes.post('/api/permissions/workspace/sync', async (_req, reply) => {
      try {
        return await syncWorkspaceDirectory();
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Sync failed' });
      }
    });

    adminRoutes.post<{ Body: ProvisionedUserInput }>('/api/permissions/workspace/users', async (req, reply) => {
      const email = req.body?.email?.trim();
      if (!email) return reply.status(400).send({ error: 'email required' });
      try {
        const user = await createProvisionedUser(req.body);
        return { user };
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Create failed' });
      }
    });

    adminRoutes.patch<{ Params: { id: string }; Body: Partial<ProvisionedUserInput> }>(
      '/api/permissions/workspace/users/:id',
      async (req, reply) => {
        const user = await updateProvisionedUser(req.params.id, req.body ?? {});
        if (!user) return reply.status(404).send({ error: 'User not found' });
        return { user };
      },
    );

    adminRoutes.delete<{ Params: { id: string } }>(
      '/api/permissions/workspace/users/:id',
      async (req, reply) => {
        const ok = await deleteProvisionedUser(req.params.id);
        if (!ok) return reply.status(404).send({ error: 'User not found' });
        return { ok: true };
      },
    );
  });
}
