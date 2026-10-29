import { createHmac } from 'node:crypto';

export type AuthFlowType = 'signup' | 'signin';

export type AuthFlowState = {
  flowType: AuthFlowType;
  /** 正規化済み（小文字） */
  email: string;
  /** Cognitoの Session 文字列（signin時、またはSignUpが返した場合） */
  session?: string;
};

export type VerifiedUser = { sub: string; email: string };

export type VerifyResult =
  /** 認証成功。IDトークンは検証済みで、sub と email のみ返す（トークン自体は返さない） */
  | { status: 'authenticated'; user: VerifiedUser }
  /** 誤コード。同じフローで再試行できる。Cognitoが新しいSessionを返した場合はそれを保存する */
  | { status: 'invalid_code'; session?: string }
  /** コード期限切れ・試行上限・セッション失効。ステップ1からやり直す */
  | { status: 'flow_expired' }
  /** 未確認ユーザーの確認完了後、サインイン用コードを追加送信した（PoCで要否を確認するフォールバック経路） */
  | { status: 'additional_code_sent'; next: AuthFlowState };

/**
 * パスワードレス（メールOTP）認証プロバイダ（§4.1, §4.2）。
 * OTPの生成・送信・有効期限・試行回数制限はプロバイダ（Cognito）に任せる。
 */
export interface OtpAuthProvider {
  readonly kind: 'cognito' | 'dev-auth';
  /** コードを送信し、フロー種別を返す。新規/既存/未確認のいずれでも呼び出し側の応答は同一にすること */
  start(email: string): Promise<AuthFlowState>;
  verify(flow: AuthFlowState, code: string): Promise<VerifyResult>;
}

/** Cognito App Client（Client Secretあり）の SECRET_HASH */
export function computeSecretHash(username: string, clientId: string, clientSecret: string): string {
  return createHmac('sha256', clientSecret)
    .update(username + clientId)
    .digest('base64');
}
