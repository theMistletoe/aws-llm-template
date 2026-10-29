import type { Context } from 'hono';
import type { z } from 'zod';
import { errors } from './errors';

const toDetails = (issues: z.core.$ZodIssue[]) =>
  issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.validation([{ path: '', message: 'JSONの形式が正しくありません' }]);
  }
  const result = schema.safeParse(body);
  if (!result.success) throw errors.validation(toDetails(result.error.issues));
  return result.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw errors.validation(toDetails(result.error.issues));
  return result.data;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (value: string) => ULID.test(value);
