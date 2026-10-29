import { createMiddleware } from 'hono/factory';
import type { AppDeps, AppEnv } from '../deps';

/** X-Request-Id の発行、セキュリティヘッダー、構造化アクセスログ（§5, §13） */
export const requestContext = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const requestId = deps.newId();
    const logger = deps.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', logger);
    const started = performance.now();
    await next();
    c.res.headers.set('X-Request-Id', requestId);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
    logger.info('http_request', {
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      latencyMs: Math.round(performance.now() - started),
    });
  });
