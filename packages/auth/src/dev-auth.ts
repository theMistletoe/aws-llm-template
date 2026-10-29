import { createHash } from 'node:crypto';
import type { AuthFlowState, OtpAuthProvider, VerifyResult } from './index';

/**
 * ローカル専用のFake OTPプロバイダ（§4.1）。固定コード `000000` を受け付ける。
 * 本番ビルド（apps/api/src/server.ts を起点とするバンドル）に含まれないことを
 * scripts/build-api.ts がこのマーカー文字列で検査する。
 */
export const DEV_AUTH_MARKER = '__AI_CHAT_DEV_AUTH_PROVIDER_MUST_NOT_SHIP__';
export const DEV_AUTH_CODE = '000000';
const MAX_ATTEMPTS = 3;

export class DevOtpAuthProvider implements OtpAuthProvider {
  readonly kind = 'dev-auth' as const;
  readonly marker = DEV_AUTH_MARKER;
  private readonly known = new Set<string>();

  async start(email: string): Promise<AuthFlowState> {
    const flowType = this.known.has(email) ? 'signin' : 'signup';
    return { flowType, email, session: 'dev:0' };
  }

  async verify(flow: AuthFlowState, code: string): Promise<VerifyResult> {
    if (code !== DEV_AUTH_CODE) {
      const attempts = Number(flow.session?.split(':')[1] ?? '0') + 1;
      if (attempts >= MAX_ATTEMPTS) return { status: 'flow_expired' };
      return { status: 'invalid_code', session: `dev:${attempts}` };
    }
    this.known.add(flow.email);
    return { status: 'authenticated', user: { sub: devSubFor(flow.email), email: flow.email } };
  }
}

/** メールアドレスから決定的なsub（UUID形式）を作る */
export function devSubFor(email: string): string {
  const h = createHash('sha256').update(`dev-auth:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
