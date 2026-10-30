# 運用手順

## デプロイ（手動。CI/CDは既定OFF）

```bash
aws sso login                        # IAM Identity Center 等（長期アクセスキーは使わない）
cp infra/deploy.config.example.json infra/deploy.config.json   # sesFromEmail 等を設定
pnpm test                            # ローカル4階層
pnpm cdk:diff                        # 差分レビュー（必須）
pnpm deploy:aws                          # ビルド → cdk deploy --all（infra/cdk-outputs.json にURL等）
pnpm smoke                           # デプロイ後の簡易確認（ログイン不要）
pnpm test:aws-smoke                  # AWS dev 受入試験（メール受信が必要。tests/aws-smoke 参照）
```

- 初回のみ: `cdk bootstrap aws://<account>/ap-northeast-1`（WAF・独自ドメイン証明書を使う場合は `us-east-1` も）。
- SES: 送信元アドレス（またはドメイン）を検証し、本番公開前にサンドボックス解除を申請する。サンドボックス中は検証済みアドレスにしか送信できない。
- **送信元ドメインの DMARC に注意**: 送信元ドメインが `p=reject`（例: 多くの使い捨てメールのドメイン）だと、SES から送った OTP メールは Gmail 等で拒否される（SES の Bounce メトリクスに出る）。自分のドメインを SES で検証して Easy DKIM の CNAME を DNS に追加し、そのドメインのアドレスを `sesFromEmail` にするのが確実。Gmail 等のフリーメールを送信元にすると届くが、迷惑メール扱いになりやすい。
- OTP メールが届かない場合: BFF ログの `otp_sent`（Cognito が受け付けたか）→ CloudWatch `AWS/SES` の `Send` / `Delivery` / `Bounce` → 迷惑メールフォルダの順に確認する。
- Bedrock: 選定モデル（既定 `jp.anthropic.claude-haiku-5-5`）が利用可能か、組織のSCPでリージョン制限していないか確認する（推論プロファイルは転送先リージョンの許可が必要）。

## ロールバック

| 対象 | 方法 |
|---|---|
| BFF | Web Function の旧 Revision へ Endpoint の `revisionWeights` を戻す（`aws lambda-web update-web-function-endpoint`）。旧ZIPは削除しない設定（prune: false） |
| Agent | `git revert` → `pnpm deploy:aws -- --stacks AgentCore`（ZIPはコンテンツハッシュ付きで不変保管） |
| SPA | `git revert` → `pnpm deploy:aws -- --stacks Frontend` |
| DB / Cognito | 破壊的変更は禁止（RETAIN・削除保護）。`cdk diff` で Replace が出たら中止する |

## インシデント対応

1. BFF の Revision を戻す。
2. WAF 有効時は CloudFront WAF で入口を遮断（無効時はアプリ側の制限、または BFF ロールの権限を一時縮小）。
3. Bedrock 権限を一時縮小（AgentCore Runtime ロールの `InvokeSelectedModel` を外す）。
4. **全ユーザーを即時ログアウトする場合**: セッションテーブルの全件を削除する（ユーザー単位の即時失効は未実装）。
   ```bash
   TABLE=chat-app-dev-session
   aws dynamodb scan --table-name $TABLE --projection-expression PK --query 'Items[].PK.S' --output text \
     | tr '\t' '\n' | while read pk; do aws dynamodb delete-item --table-name $TABLE --key "{\"PK\":{\"S\":\"$pk\"}}"; done
   ```
5. CloudTrail を保全する。

## ユーザーデータ削除（退会は画面機能なし）

```bash
pnpm delete-user -- --email user@example.com --stage dev          # ドライラン
pnpm delete-user -- --email user@example.com --stage dev --yes    # Cognitoユーザー・会話・Usageを削除
```

- セッション行は最大8時間で失効する（ユーザー単位の索引を持たないため削除しない）。
- PITR には最大35日間データが残る。プライバシーポリシーに明記すること。

## 監視

- ログ: BFF は `/chat-app/<stage>/bff`（JSON構造化、保持30日）、AgentCore Runtime は `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`。
- アラーム（SNS → `alarmEmail`）: BFF 5xx、生成失敗（AgentCore Runtime / Gateway / モデル）、DynamoDB throttling。
- 拡張: AgentCore Observability（トレース）を使う場合は CloudWatch Transaction Search をアカウント単位で有効化し、Runtime に ADOT を導入する（本キットは既定で使わない）。

## 任意機能の有効化

`infra/deploy.config.json` で個別に ON にし、`pnpm cdk:diff` を確認してから `pnpm deploy:aws`。

| オプション | 追加されるもの | 注意 |
|---|---|---|
| `enableWaf` | `ChatApp-<stage>-Waf`（us-east-1）| まず Count で誤検知を確認し、`WafStack` の `blockMode` で Block へ |
| `enableBudgets` | 月次予算と通知（`budgetEmail`） | 支出は止まらない。BFFの利用上限は必須 |
| `enableCiCd` | GitHub OIDC ロール | `.github/workflows` は `vars.ENABLE_CICD == 'true'` で有効化 |
| `useCustomDomain` | 代替ドメイン名・証明書 | `docs/custom-domain-migration.md` |
