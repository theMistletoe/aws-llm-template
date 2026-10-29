# 独自ドメインへの移行手順（§4.5）

初期構築は CloudFront 標準ドメイン（`*.cloudfront.net`）。独自ドメインへ移行すると `__Host-session` Cookie はホストに紐づくため、**全ユーザーが再ログイン**になる（許容済み。パスキー不採用のため再登録は不要）。

1. **証明書**: ACM で `us-east-1` に証明書を発行する（CloudFront 用）。DNS 検証を完了させる。
2. **設定**: `infra/deploy.config.json` に以下を追加する。
   ```json
   {
     "useCustomDomain": true,
     "customDomainName": "chat.example.com",
     "customDomainCertificateArn": "arn:aws:acm:us-east-1:<account>:certificate/<id>"
   }
   ```
3. **差分確認**: `pnpm cdk:diff`。Frontend の Aliases/証明書、Api の `APP_ORIGIN`（SSM参照から固定値へ）が変わることを確認する。
4. **デプロイ**: `pnpm deploy:aws`。
5. **DNS**: `chat.example.com` を CloudFront ディストリビューションへ ALIAS/CNAME で向ける。
6. **SES**: 送信元をドメイン認証（DKIM/SPF/DMARC）に切り替えると到達率が上がる（`sesFromEmail` を `no-reply@example.com` 等へ）。
7. **確認**: `APP_URL=https://chat.example.com pnpm smoke`、`pnpm test:aws-smoke`。
8. 旧URL（`*.cloudfront.net`）でアクセスしたユーザーは Origin 不一致で状態変更APIが 403 になる。必要なら案内を出す。

戻す場合は `useCustomDomain: false` で再デプロイする（再度全ユーザーが再ログイン）。
