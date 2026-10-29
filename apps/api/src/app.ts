import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from './deps';
import { errors } from './lib/errors';
import { errorHandler, toErrorResponse } from './middleware/error-handler';
import { originCheck } from './middleware/origin-check';
import { requestContext } from './middleware/request-context';
import { requireSession } from './middleware/session';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chats';
import { diagnosticsRoutes } from './routes/diagnostics';

/**
 * Hono app定義（実行基盤非依存）。AWS（Web Functions / Function URL）とlocalで同じルーティングを使い、
 * 違いはアダプター（server.ts / local.ts）と依存の注入のみ（§10）。
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(deps));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw errors.payloadTooLarge();
      },
    }),
  );
  app.use('/api/*', originCheck(deps));
  app.onError(errorHandler(deps));
  app.notFound((c) => toErrorResponse(c, errors.notFound()));

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/auth', authRoutes(deps));
  app.use('/api/v1/*', requireSession(deps));
  app.route('/api/v1', chatRoutes(deps));
  if (deps.config.diagnosticsEnabled) app.route('/api/v1/diagnostics', diagnosticsRoutes(deps));
  return app;
}
