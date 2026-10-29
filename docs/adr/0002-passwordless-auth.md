# ADR 0002: パスワードレス認証（Cognito メールOTP + 自前1画面）

- 状態: 採用
- 日付: 2026-10-29

## 決定

- Cognito User Pool（Essentials）を BFF から SDK で呼ぶ。Managed Login・Cognitoドメイン・OAuthリダイレクトは使わない。
- 新規: `SignUp`（パスワードなし）→ `ConfirmSignUp(Session)` → `InitiateAuth(USER_AUTH, Session)` で確認コードのまま自動サインイン（メール1通）。
- 既存: `SignUp` が `UsernameExistsException` → `InitiateAuth(USER_AUTH, PREFERRED_CHALLENGE=EMAIL_OTP)` → `RespondToAuthChallenge(EMAIL_OTP)`。
- 未確認（登録途中離脱）: `InitiateAuth` が `UserNotConfirmedException` → `ResendConfirmationCode`。確認後に自動サインイン用 Session が得られない場合はサインイン用コードを追加送信し、`202 additional_code_sent` を返す（UIは同じコード入力欄のまま案内）。
- App Client は `ALLOW_USER_AUTH` のみ、Client Secret あり（Secrets Manager）、`PreventUserExistenceErrors`。ID Token は `aws-jwt-verify` で検証して破棄する。
- フロー情報（種別・メール・Cognito Session）はセッションテーブルに5分保存し、`__Host-auth-flow` には乱数の flowId のみを入れる。条件付き削除で一度だけ消費し、誤コード時のみ再保存する。

## 実装上の制約と対応

| 事項 | 内容 | 対応 |
|---|---|---|
| 第1要素の PASSWORD | Cognito（および CDK L2）はユーザープールの `AllowedFirstAuthFactors` から `PASSWORD` を外せない | プールは `PASSWORD, EMAIL_OTP`。App Client を `ALLOW_USER_AUTH` のみにし、ユーザーはパスワードなしで登録されるため、パスワードでのサインインは成立しない。BFF は EMAIL_OTP 以外を要求しない |
| コードの桁数 | 確認コード・ログインコードの桁数は Cognito 側の仕様 | 入力は 6〜8 桁の数字を許容（dev-auth は `000000`） |
| メール送信 | EMAIL_OTP は SES 連携が前提 | `UserPoolEmail.withSES`。サンドボックス解除はキット利用者が申請 |
| 登録有無の推測 | 応答・時間差 | otp/start は常に202・同一本文、最低応答時間（既定800ms）、メール単位の送信レート制限 |

## PoC関門（AWS dev）の結果

[0000-poc-gate.md](0000-poc-gate.md) を参照。
