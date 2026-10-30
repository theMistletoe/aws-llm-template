# 脅威モデル（STRIDE）

対象: AIチャット スターターキット（React SPA / Hono BFF / Cognito メールOTP / AgentCore Runtime + Gateway Web Search / DynamoDB）。
前提: 小規模公開。キット利用者が自分のAWSアカウントで運用する。

## 信頼境界

```text
[ブラウザ] ──HTTPS──▶ [CloudFront] ──OAC(SigV4)──▶ [BFF: Lambda Web Functions]
                                   └─OAC──▶ [S3 (SPA)]
[BFF] ──SDK──▶ [Cognito] ──▶ [SES]
[BFF] ──SDK──▶ [DynamoDB]
[BFF] ──SigV4──▶ [AgentCore Runtime] ──▶ [Bedrock（推論プロファイル）]
                                    └─SigV4/MCP──▶ [AgentCore Gateway] ──▶ [Web Search]
```

| # | 境界 | 主な脅威 | 対策（実装箇所） |
|---|---|---|---|
| S1 | ブラウザ→BFF | セッション窃取・固定化 | `__Host-session`（Secure/HttpOnly/SameSite=Lax/Path=/）、256bit乱数、DBにはSHA-256のみ保存、ログイン時に旧セッション失効（`apps/api/src/routes/auth.ts`） |
| S2 | ブラウザ→BFF | なりすまし（他人のuserId指定） | userIdは受け取らず検証済みセッションのsubのみ使用、Zod strict で未知フィールド拒否 |
| T1 | ブラウザ→BFF | CSRF | 状態変更はOrigin完全一致（欠落も拒否）、SameSite=Lax、GETで状態変更しない（`middleware/origin-check.ts`） |
| R1 | BFF | 否認・追跡不能 | X-Request-Id、構造化ログ（本文・メール・トークン・コードは出さない。`lib/logger.ts`） |
| I1 | 認証API | アカウント列挙 | otp/start は新規・既存・未確認で同一応答、最低応答時間、`PreventUserExistenceErrors`、メール単位のレート制限 |
| I2 | チャットAPI | 他人のデータ閲覧 | 全操作でownerSub検証、存在しない／他人は同じ404、カーソル改ざん検出（`repositories/chat-repository.ts`） |
| I3 | ブラウザ | トークン漏えい | Cognitoトークンはブラウザへ返さず保存もしない。ID Tokenは`aws-jwt-verify`で検証後に破棄 |
| I4 | AI出力 | XSS | Markdownは生HTMLを描画しない（skipHtml）、URLはhttp/httpsのみ、CSP（`script-src 'self'`） |
| I5 | Web検索 | プロンプトインジェクション・データ流出 | 公開ツールは`web_search`のみ、検索結果は非信頼データと明示、任意URLフェッチ不可、出典は検索ツールの実結果からのみ生成 |
| D1 | 生成API | コスト枯渇（DoW） | チャット単位の同時実行1、入力4,000文字、出力2,048トークン、検索3回/回答。**ユーザー単位の回数上限はなし**（ADR 0006）。公開時は WAF のレートベースルールや全体の上限で補う |
| D2 | 認証API | コード送信の連打 | 60秒に1回・1時間に5回（DynamoDB）、Cognito標準制限、任意でWAFレートベースルール |
| D3 | 全体 | アカウント大量作成 | 対象外（キット利用者が公開時に全体上限・WAF・Budgetsを検討。README参照） |
| E1 | BFF→AWS | 権限昇格 | BFFロールはDynamoDB・Secret・SSM 1件・指定RuntimeのInvoke/Stopのみ。Bedrock直接推論権限なし |
| E2 | Agent→AWS | 権限昇格 | Runtimeロールは選定推論プロファイル＋転送先基盤モデル、指定GatewayのInvokeのみ。GatewayロールはWeb Searchのみ |
| E3 | 本番設定 | ローカル用実装の混入 | `APP_MODE=aws` で dev-auth・固定モデル・fixture・エンドポイント上書きを起動時に拒否（fail-closed）。本番バンドルにdev-authマーカーが無いことをビルド時に検査 |
| E4 | BFFエンドポイント | CloudFront迂回 | Web Function は `IamAuth`、リソースポリシーで当該DistributionのARNのみ許可 |

## 残存リスク（キット利用者の判断事項）

- アカウントの強度は利用者のメールアカウントの安全性に依存する。
- ユーザー単位の全セッション即時失効は未実装（最大8時間有効）。緊急時はセッションテーブル全体の消去で全ユーザーをログアウトする（`docs/operations.md`）。
- 推論（推論プロファイル）とWeb検索は東京リージョン外・外部事業者で処理され得る。
- ユーザー単位の利用回数上限（クォータ）とサービス全体のコスト上限（キルスイッチ）は未実装（ADR 0006）。
