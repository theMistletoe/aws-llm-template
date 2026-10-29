import type { ApiError } from '@ai-chat/contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppDeps, AppEnv } from '../deps';
import { AppError, errors } from '../lib/errors';

export function toErrorResponse(c: Context<AppEnv>, error: AppError) {
  const body: ApiError = {
    error: {
      code: error.code,
      message: error.message,
      requestId: c.get('requestId') ?? 'unknown',
      retryable: error.options.retryable ?? false,
      ...(error.options.retryAfter ? { retryAfter: error.options.retryAfter } : {}),
      ...(error.options.details ? { details: error.options.details } : {}),
    },
  };
  if (error.options.retryAfter) {
    const seconds = Math.max(0, Math.ceil((Date.parse(error.options.retryAfter) - Date.now()) / 1000));
    c.header('Retry-After', String(seconds));
  }
  return c.json(body, error.status);
}

export const errorHandler = (deps: AppDeps) => (err: Error, c: Context<AppEnv>) => {
  if (err instanceof AppError) return toErrorResponse(c, err);
  if (err instanceof HTTPException) {
    if (err.status === 413) return toErrorResponse(c, errors.payloadTooLarge());
    return toErrorResponse(c, errors.validation());
  }
  (c.get('logger') ?? deps.logger).error('unhandled_error', { errorClass: err.name, route: c.req.routePath });
  return toErrorResponse(c, errors.internal());
};
