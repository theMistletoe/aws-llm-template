import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { computeSecretHash, type AuthFlowState, type OtpAuthProvider, type VerifyResult } from './index';

export type CognitoOtpAuthOptions = {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Secrets Managerから取得したClient Secretを返す（呼び出し側でキャッシュする） */
  getClientSecret: () => Promise<string>;
  client?: CognitoIdentityProviderClient;
  /** テスト用にIDトークン検証を差し替える */
  verifyIdToken?: (idToken: string) => Promise<{ sub: string; email?: unknown }>;
};

export class CognitoAuthError extends Error {
  constructor(
    message: string,
    readonly causeName?: string,
  ) {
    super(message);
    this.name = 'CognitoAuthError';
  }
}

const errorName = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : undefined;

/** 再試行可能な誤コード */
const INVALID_CODE_ERRORS = new Set(['CodeMismatchException']);
/** フローをやり直すべきエラー（期限切れ、試行上限、セッション失効、確認済み等） */
const FLOW_EXPIRED_ERRORS = new Set([
  'ExpiredCodeException',
  'NotAuthorizedException',
  'TooManyFailedAttemptsException',
  'UserNotFoundException',
  'AliasExistsException',
]);

/**
 * Cognito User Pool（Essentials, USER_AUTH + EMAIL_OTPのみ）をSDKで呼び出すプロバイダ。
 * Managed Loginは使わない（§4.1）。
 */
export class CognitoOtpAuthProvider implements OtpAuthProvider {
  readonly kind = 'cognito' as const;
  private readonly client: CognitoIdentityProviderClient;
  private readonly verifyIdToken: (idToken: string) => Promise<{ sub: string; email?: unknown }>;

  constructor(private readonly options: CognitoOtpAuthOptions) {
    this.client = options.client ?? new CognitoIdentityProviderClient({ region: options.region });
    if (options.verifyIdToken) {
      this.verifyIdToken = options.verifyIdToken;
    } else {
      const verifier = CognitoJwtVerifier.create({
        userPoolId: options.userPoolId,
        tokenUse: 'id',
        clientId: options.clientId,
      });
      this.verifyIdToken = async (token) => {
        const payload = await verifier.verify(token);
        return { sub: payload.sub, email: payload.email };
      };
    }
  }

  private async secretHash(email: string): Promise<string> {
    return computeSecretHash(email, this.options.clientId, await this.options.getClientSecret());
  }

  async start(email: string): Promise<AuthFlowState> {
    const SecretHash = await this.secretHash(email);
    try {
      const res = await this.client.send(
        new SignUpCommand({
          ClientId: this.options.clientId,
          SecretHash,
          Username: email,
          UserAttributes: [{ Name: 'email', Value: email }],
        }),
      );
      return { flowType: 'signup', email, ...(res.Session ? { session: res.Session } : {}) };
    } catch (e) {
      if (errorName(e) !== 'UsernameExistsException') throw e;
    }
    try {
      return await this.initiateEmailOtp(email, SecretHash);
    } catch (e) {
      if (errorName(e) !== 'UserNotConfirmedException') throw e;
    }
    // 登録途中で離脱した未確認ユーザー：確認コードを再送する
    await this.client.send(
      new ResendConfirmationCodeCommand({ ClientId: this.options.clientId, SecretHash, Username: email }),
    );
    return { flowType: 'signup', email };
  }

  async verify(flow: AuthFlowState, code: string): Promise<VerifyResult> {
    try {
      return flow.flowType === 'signup' ? await this.verifySignUp(flow, code) : await this.verifySignIn(flow, code);
    } catch (e) {
      const name = errorName(e);
      if (name && INVALID_CODE_ERRORS.has(name)) return { status: 'invalid_code' };
      if (name && FLOW_EXPIRED_ERRORS.has(name)) return { status: 'flow_expired' };
      throw e;
    }
  }

  private async verifySignUp(flow: AuthFlowState, code: string): Promise<VerifyResult> {
    const SecretHash = await this.secretHash(flow.email);
    const confirmed = await this.client.send(
      new ConfirmSignUpCommand({
        ClientId: this.options.clientId,
        SecretHash,
        Username: flow.email,
        ConfirmationCode: code,
        ...(flow.session ? { Session: flow.session } : {}),
      }),
    );
    if (confirmed.Session) {
      // 確認コードのまま自動サインイン（メールは1通で済む）
      const auth = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.options.clientId,
          AuthFlow: 'USER_AUTH',
          AuthParameters: { USERNAME: flow.email, SECRET_HASH: SecretHash },
          Session: confirmed.Session,
        }),
      );
      if (auth.AuthenticationResult) return this.authenticated(auth.AuthenticationResult, flow.email);
    }
    // 自動サインイン用Sessionが無い場合（未確認ユーザーの再開など）はサインイン用コードを送る
    const next = await this.initiateEmailOtp(flow.email, SecretHash);
    return { status: 'additional_code_sent', next };
  }

  private async verifySignIn(flow: AuthFlowState, code: string): Promise<VerifyResult> {
    if (!flow.session) return { status: 'flow_expired' };
    const SecretHash = await this.secretHash(flow.email);
    const res = await this.client.send(
      new RespondToAuthChallengeCommand({
        ClientId: this.options.clientId,
        ChallengeName: 'EMAIL_OTP',
        Session: flow.session,
        ChallengeResponses: { USERNAME: flow.email, EMAIL_OTP_CODE: code, SECRET_HASH: SecretHash },
      }),
    );
    if (res.AuthenticationResult) return this.authenticated(res.AuthenticationResult, flow.email);
    if (res.ChallengeName === 'EMAIL_OTP' && res.Session) return { status: 'invalid_code', session: res.Session };
    throw new CognitoAuthError(`Unexpected challenge: ${res.ChallengeName ?? 'none'}`);
  }

  private async initiateEmailOtp(email: string, SecretHash: string): Promise<AuthFlowState> {
    const res = await this.client.send(
      new InitiateAuthCommand({
        ClientId: this.options.clientId,
        AuthFlow: 'USER_AUTH',
        AuthParameters: { USERNAME: email, SECRET_HASH: SecretHash, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
      }),
    );
    if (res.ChallengeName !== 'EMAIL_OTP' || !res.Session) {
      throw new CognitoAuthError(`Unexpected challenge: ${res.ChallengeName ?? 'none'}`);
    }
    return { flowType: 'signin', email, session: res.Session };
  }

  private async authenticated(result: AuthenticationResultType, email: string): Promise<VerifyResult> {
    if (!result.IdToken) throw new CognitoAuthError('IdToken missing');
    const payload = await this.verifyIdToken(result.IdToken);
    const tokenEmail = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
    if (tokenEmail !== email) throw new CognitoAuthError('IdToken email mismatch');
    // Cognitoのトークンは検証にのみ使い、保存も返却もしない（§4.3）
    return { status: 'authenticated', user: { sub: payload.sub, email } };
  }
}
