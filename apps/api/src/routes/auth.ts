import { otpStartInputSchema, otpVerifyInputSchema, type Me, type OtpStartResponse } from '@ai-chat/contracts';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AuthService } from '../auth/auth-service';
import type { AppDeps, AppEnv } from '../deps';
import { sha256Hex } from '../lib/crypto';
import { AppError, errors } from '../lib/errors';
import { parseJson } from '../lib/validation';
import { AUTH_FLOW_COOKIE, SESSION_COOKIE, hostCookie } from '../middleware/cookies';
import { requireSession } from '../middleware/session';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function authRoutes(deps: AppDeps) {
  const service = new AuthService(deps);
  const r = new Hono<AppEnv>();

  r.post('/otp/start', async (c) => {
    const started = Date.now();
    try {
      const { email } = await parseJson(c, otpStartInputSchema);
      const { flowId } = await service.startOtp(email);
      setCookie(c, AUTH_FLOW_COOKIE, flowId, hostCookie(deps.config.session.authFlowTtlSeconds));
      const body: OtpStartResponse = {
        status: 'code_sent',
        message: '確認コードを送信しました。メールをご確認ください',
        resendAfterSeconds: deps.config.otp.cooldownSeconds,
      };
      return c.json(body, 202);
    } finally {
      // 登録有無で所要時間に大きな差が出ないよう、最低応答時間まで待つ（§4.2）
      const remaining = deps.config.otp.minResponseMs - (Date.now() - started);
      if (remaining > 0) await sleep(remaining);
    }
  });

  r.post('/otp/verify', async (c) => {
    const { code } = await parseJson(c, otpVerifyInputSchema);
    const flowId = getCookie(c, AUTH_FLOW_COOKIE);
    if (!flowId || !/^[A-Za-z0-9_-]{43}$/.test(flowId)) throw errors.authFlowExpired();
    let outcome;
    try {
      outcome = await service.verifyOtp(flowId, code);
    } catch (e) {
      if (e instanceof AppError && e.code === 'AUTH_FLOW_EXPIRED') {
        deleteCookie(c, AUTH_FLOW_COOKIE, { path: '/', secure: true });
      }
      throw e;
    }
    if (outcome.kind === 'additional_code_sent') {
      return c.json(
        { status: 'additional_code_sent', message: 'メールアドレスを確認しました。ログイン用のコードを送信しました' },
        202,
      );
    }
    // セッション固定化対策: 既存セッションがあれば失効させ、新しいIDを発行する
    const previous = getCookie(c, SESSION_COOKIE);
    if (previous) await service.revokeSession(sha256Hex(previous));
    deleteCookie(c, AUTH_FLOW_COOKIE, { path: '/', secure: true });
    setCookie(c, SESSION_COOKIE, outcome.sessionId, hostCookie(deps.config.session.absoluteTtlSeconds));
    return c.body(null, 204);
  });

  r.get('/me', requireSession(deps), (c) => {
    const user = c.get('user');
    const body: Me = { sub: user.sub, email: user.email };
    return c.json(body);
  });

  r.post('/logout', requireSession(deps), async (c) => {
    await service.revokeSession(c.get('sessionHash'));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.body(null, 204);
  });

  return r;
}
