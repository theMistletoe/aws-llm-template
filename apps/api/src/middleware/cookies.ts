import type { CookieOptions } from 'hono/utils/cookie';

export const SESSION_COOKIE = '__Host-session';
export const AUTH_FLOW_COOKIE = '__Host-auth-flow';

/** `__Host-` Cookie: Secure・Path=/・Domainなし（§4.3） */
export const hostCookie = (maxAge: number): CookieOptions => ({
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  maxAge,
});
