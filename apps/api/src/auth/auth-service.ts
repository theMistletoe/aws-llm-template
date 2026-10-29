import type { AuthFlowState } from '@ai-chat/auth';
import { normalizeEmail } from '@ai-chat/contracts';
import type { AppDeps, SessionUser } from '../deps';
import { randomToken, sha256Hex } from '../lib/crypto';
import { AppError, errors } from '../lib/errors';
import { epochSeconds } from '../lib/time';

const errorName = (e: unknown) =>
  typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : 'Error';

const PROVIDER_THROTTLED = new Set(['TooManyRequestsException', 'LimitExceededException']);
const PROVIDER_BAD_INPUT = new Set(['InvalidParameterException']);

export type VerifyOutcome =
  | { kind: 'authenticated'; sessionId: string; user: SessionUser }
  | { kind: 'additional_code_sent' };

/**
 * パスワードレス認証（§4.2）とアプリセッション（§4.3）。
 * BFFの責務はプロバイダAPIの呼び分け・フローの一時保管・セッション発行に限る。
 */
export class AuthService {
  constructor(private readonly deps: AppDeps) {}

  /** ステップ1: コード送信。新規・既存・未確認で応答を変えないこと（呼び出し側は常に202） */
  async startOtp(rawEmail: string): Promise<{ flowId: string }> {
    const email = normalizeEmail(rawEmail);
    const now = this.deps.clock.now();
    const nowSec = epochSeconds(now);
    const { cooldownSeconds, maxPerHour } = this.deps.config.otp;
    const reservation = await this.deps.sessions.reserveOtpSend(sha256Hex(email), nowSec, cooldownSeconds, maxPerHour);
    if (!reservation.ok) throw errors.rateLimited(new Date(reservation.retryAt * 1000).toISOString());

    let flow: AuthFlowState;
    try {
      flow = await this.deps.auth.start(email);
    } catch (e) {
      const name = errorName(e);
      this.deps.logger.warn('otp_start_failed', { errorClass: name });
      if (PROVIDER_THROTTLED.has(name)) throw errors.rateLimited(new Date((nowSec + cooldownSeconds) * 1000).toISOString());
      if (PROVIDER_BAD_INPUT.has(name)) throw errors.validation([{ path: 'email', message: 'メールアドレスを確認してください' }]);
      throw errors.authUnavailable();
    }

    const flowId = randomToken();
    await this.deps.sessions.putAuthFlow(sha256Hex(flowId), {
      flowType: flow.flowType,
      email,
      ...(flow.session ? { cognitoSession: flow.session } : {}),
      createdAt: now.toISOString(),
      expiresAt: nowSec + this.deps.config.session.authFlowTtlSeconds,
    });
    this.deps.logger.info('otp_sent', { flowType: flow.flowType });
    return { flowId };
  }

  /** ステップ2: コード検証。フローは条件付き削除で一度だけ消費し、誤コード時のみ再保存する */
  async verifyOtp(flowId: string, code: string): Promise<VerifyOutcome> {
    const flowHash = sha256Hex(flowId);
    const now = this.deps.clock.now();
    const nowSec = epochSeconds(now);
    const stored = await this.deps.sessions.consumeAuthFlow(flowHash, nowSec);
    if (!stored) throw errors.authFlowExpired();

    const flow: AuthFlowState = {
      flowType: stored.flowType,
      email: stored.email,
      ...(stored.cognitoSession ? { session: stored.cognitoSession } : {}),
    };
    let result;
    try {
      result = await this.deps.auth.verify(flow, code);
    } catch (e) {
      this.deps.logger.warn('otp_verify_failed', { errorClass: errorName(e) });
      if (e instanceof AppError) throw e;
      throw errors.authFlowExpired();
    }

    switch (result.status) {
      case 'invalid_code': {
        // 同じflowIdで再試行できるよう、元の有効期限のまま再保存する
        await this.deps.sessions.putAuthFlow(flowHash, {
          ...stored,
          ...(result.session ? { cognitoSession: result.session } : {}),
        });
        throw errors.invalidCode();
      }
      case 'flow_expired':
        throw errors.authFlowExpired();
      case 'additional_code_sent':
        await this.deps.sessions.putAuthFlow(flowHash, {
          flowType: result.next.flowType,
          email: result.next.email,
          ...(result.next.session ? { cognitoSession: result.next.session } : {}),
          createdAt: now.toISOString(),
          expiresAt: nowSec + this.deps.config.session.authFlowTtlSeconds,
        });
        return { kind: 'additional_code_sent' };
      case 'authenticated': {
        const sessionId = await this.createSession(result.user);
        this.deps.logger.info('login_succeeded', { flowType: flow.flowType });
        return { kind: 'authenticated', sessionId, user: result.user };
      }
    }
  }

  async createSession(user: SessionUser): Promise<string> {
    const sessionId = randomToken();
    const now = this.deps.clock.now();
    const nowSec = epochSeconds(now);
    await this.deps.sessions.putSession({
      sessionHash: sha256Hex(sessionId),
      userSub: user.sub,
      email: user.email,
      createdAt: now.toISOString(),
      lastSeenAt: nowSec,
      expiresAt: nowSec + this.deps.config.session.absoluteTtlSeconds,
    });
    return sessionId;
  }

  async revokeSession(sessionHash: string): Promise<void> {
    await this.deps.sessions.revokeSession(sessionHash, this.deps.clock.now());
  }
}
