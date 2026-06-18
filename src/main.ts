import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { registerAccessRoutes } from './api/access.js';
import { registerPermissionsRoutes } from './api/permissions.js';
import { registerWorkspaceRoutes } from './api/workspace.js';
import { runMigrations } from './db/client.js';
import { createPortalAdapter } from './portal/adapter.js';

const PORT = Number(process.env.PORT ?? 8771);
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } },
    },
    trustProxy: true,
  });

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) app.log.warn('SESSION_SECRET is not set');
  await app.register(cookie, { secret: sessionSecret ?? 'unsafe-dev-only-do-not-use-in-prod' });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (process.env.NODE_ENV !== 'production') return cb(null, true);
      const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      cb(null, allowed.includes(origin));
    },
    credentials: true,
  });

  await runMigrations();

  const portal = await createPortalAdapter();

  app.get('/health', async () => ({ status: 'ok', service: 'prism-permissions' }));

  await registerAccessRoutes(app, portal);
  await registerPermissionsRoutes(app, portal);
  await registerWorkspaceRoutes(app);

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      app.log.info({ sig }, 'shutdown');
      await app.close();
      process.exit(0);
    });
  }
}

main();
