import { deleteCookie, getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppDeps, AppEnv } from '../deps';
import { sha256Hex } from '../lib/crypto';
import { errors } from '../lib/errors';
import { epochSeconds } from '../lib/time';
import { SESSION_COOKIE } from './cookies';

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * BFFセッション認証（§4.3）。DBのSHA-256(sessionId)行を引き、失効・絶対期限・非操作期限を毎回検証する。
 * lastSeenAt は一定間隔でのみ更新する。
 */
export const requireSession = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const raw = getCookie(c, SESSION_COOKIE);
    if (!raw) throw errors.unauthenticated();
    const reject = () => {
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
      return errors.unauthenticated();
    };
    if (!SESSION_ID.test(raw)) throw reject();
    const hash = sha256Hex(raw);
    const session = await deps.sessions.getSession(hash);
    const nowSec = epochSeconds(deps.clock.now());
    const { idleTtlSeconds, touchIntervalSeconds } = deps.config.session;
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= nowSec ||
      nowSec - session.lastSeenAt >= idleTtlSeconds
    ) {
      throw reject();
    }
    if (nowSec - session.lastSeenAt >= touchIntervalSeconds) {
      await deps.sessions.touchSession(hash, nowSec);
    }
    c.set('user', { sub: session.userSub, email: session.email });
    c.set('sessionHash', hash);
    await next();
  });
