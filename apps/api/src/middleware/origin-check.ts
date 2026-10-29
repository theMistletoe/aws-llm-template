import { createMiddleware } from 'hono/factory';
import type { AppDeps, AppEnv } from '../deps';
import { errors } from '../lib/errors';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 状態変更リクエストは Origin を APP_ORIGIN と完全一致で検証し、欠落時は拒否する（§4.3） */
export const originCheck = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (STATE_CHANGING.has(c.req.method)) {
      const origin = c.req.header('Origin');
      const expected = await deps.resolveAppOrigin();
      if (!origin || origin !== expected) throw errors.forbiddenOrigin();
    }
    await next();
  });
