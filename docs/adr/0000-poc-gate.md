# ADR 0000: Phase 0 PoC関門の結果（AWS dev）

- 日付: 2026-10-29（JST 2026-10-30 未明）
- 環境: AWS dev（`ap-northeast-1`、stage `dev`）。`pnpm deploy:aws` で全6スタック（Data / Auth / AgentCore / Api / Frontend / Monitoring）をデプロイし、`pnpm smoke` と `pnpm test:aws-smoke`、および個別のPoCスクリプトで確認した。
- 結論: **すべての必須項目が合格。BFF実行基盤は Lambda Web Functions（`bffPlatform: 'web-functions'`）を採用**（[ADR 0001](0001-bff-platform.md)）。

## Lambda Web Functions（§9.4）

| 確認項目 | 結果 | 根拠 |
|---|---|---|
| CloudFront + OAC 経由の POST（`x-amz-content-sha256` の要否） | ✅ 合格。**不要**（OAC `always-amz-auth` が UNSIGNED-PAYLOAD で署名） | otp/start・verify・stream の POST が成功 |
| SSE 逐次配信 | ✅ 合格 | 124 デルタが約3秒にわたり順次到着（バッファリングなし） |
| ハートビートで 120 秒ストリーム | ✅ 合格 | 診断用SSE（データなし・15秒ごとのコメント行のみ）が CloudFront の読み取りタイムアウト（60秒）を超えて **125.3 秒で完了**。各 ping は 15.0 秒間隔で即時到着 |
| Cookie 転送 | ✅ 合格 | `__Host-session` / `__Host-auth-flow` が往復し、認証・セッションが機能 |
| クライアント中断の検知 | ✅ 合格 | Abort 後に BFF が検知し `interrupted` を記録、`StopRuntimeSession` 成功（失敗ログなし） |
| BFF への直接アクセス不可 | ✅ 合格 | Web Function エンドポイント（`IamAuth`）への直接リクエストは 403 |
| L1 デプロイと Revision 切り戻し | ✅ 合格（修正あり） | 旧 Revision へ Endpoint の重みを戻して約 6.6 秒で切替、現行版へ即時復帰。Revision は置換時に削除されるため **RETAIN を付与**して旧版を保持するよう修正した |

## Cognito（§4.2 要PoC）

| 確認項目 | 結果 |
|---|---|
| パスワードなしの `SignUp` | ✅ 成功（確認コードのメールが1通） |
| `ConfirmSignUp` の `Session` による自動サインイン | ✅ 成功（新規登録はメール1通でログイン完了） |
| `EMAIL_OTP` サインイン（既存ユーザー） | ✅ 成功。**サインインコードは 8 桁**（確認コードは 6 桁）。入力は 6〜8 桁を許容 |
| `PreventUserExistenceErrors` 有効時の挙動 | ✅ `SignUp` は既存ユーザーで `UsernameExistsException` を返す（BFF 内部の分岐に使用。応答は常に同一の 202） |
| 未確認ユーザー（登録途中で離脱） | ✅ `InitiateAuth(USER_AUTH, EMAIL_OTP)` がそのまま成功し、OTP でサインインすると `CONFIRMED` になった。`ResendConfirmationCode` 経路はフォールバックとして残す |
| 誤コード時の `Session` | ✅ 誤コードは `400 INVALID_CODE`、同じフローで正しいコードを入れると 204 |
| 登録有無の推測 | ✅ 応答は同一（202・同一本文）。所要時間は既存 1.09 秒・新規 0.88 秒（最低応答時間 0.8 秒） |
| SES 送信 | ✅ サンドボックス内で検証済みアドレス間の送信に成功。**本番公開前にサンドボックス解除が必要** |
| 既知事項 | サインインコードのメール件名・本文は Cognito 既定（"Your authentication code"）のままで、`EmailAuthenticationSubject/Message` の指定は反映されなかった（確認コードのテンプレートは反映） |

## Strands TS SDK

| 確認項目 | 結果 |
|---|---|
| MCP クライアント | ✅ Strands `McpClient` + `@modelcontextprotocol/client` v2（SigV4 署名 fetch）で Gateway の `WebSearch` を呼び出し成功 |
| カスタムモデルプロバイダ | ✅ `Model` を継承した `FixedModelProvider` がツール呼び出しを含めて動作（ローカル・テスト） |
| ストリーミングイベント | ✅ テキスト差分・ツール開始/終了・使用量を AgentEvent に変換 |

## AgentCore

| 確認項目 | 結果 |
|---|---|
| Node.js ZIP デプロイ（`NODE_22`、ESM バンドル + `{"type":"module"}`） | ✅ Runtime `READY`、`/ping`・`/invocations` が SSE で応答 |
| Bedrock 推論（推論プロファイル） | ✅ `jp.anthropic.claude-haiku-4-5-20251001-v1:0` で成功。既定の `jp.anthropic.claude-haiku-5-5` は**当該アカウントで未提供（AccessDenied: not available for this account）**のため dev はこのモデルで検証（[ADR 0005](0005-model-selection.md)） |
| IAM がプロファイル以外を拒否 | ✅ ポリシーシミュレーターで選定プロファイル・基盤モデルは allowed、`jp…opus-5-5`・`sonnet-4-6` は implicitDeny。BFF ロールの `bedrock:InvokeModel` は implicitDeny |
| Gateway IAM / MCP Web Search | ✅ 検索結果と出典（https、5件）を取得。BFF→ブラウザに `tool_status` と `source` のみ転送 |
| 会話単位セッションの再利用 | ✅ 初回の最初のトークンまで約 3 秒（microVM 起動含む生成全体 6.1 秒）、2 回目以降は約 2.4 秒 |
| `StopRuntimeSession` | ✅ 中断・削除時に呼び出し、失敗ログなし |
| アイドルタイムアウト | 設定値（300 秒）の反映のみ確認。解放の実測は未実施 |

## 受入試験（§12.6）

`pnpm test:aws-smoke`: **9/9 合格**（AWS-01 新規登録・未確認ユーザー・ログアウト即時失効、AWS-03 SSE と中断、AWS-05 Web Search、AWS-07 分離、AWS-08 セッション再利用と削除）。`pnpm smoke`: **8/8 合格**（AWS-02 SPA と API の分離、直接アクセス不可、セキュリティヘッダー、Origin チェック）。

| ID | 状態 |
|---|---|
| AWS-01〜08 | ✅（AWS-06 の否定側は IAM ポリシーシミュレーター、AWS-08 のアイドル解放は設定のみ） |
| AWS-07 のツール上限 | ローカルのユニット・結合テストで検証（クォータは後に要件から削除。ADR 0006） |
| AWS-09 任意機能 | OFF で正常稼働を確認。ON は `cdk synth` と CDK テストで構成を検証（AWS への適用は未実施） |
