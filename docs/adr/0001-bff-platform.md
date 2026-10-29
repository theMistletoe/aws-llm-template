# ADR 0001: BFF 実行基盤 — Lambda Web Functions を採用

- 状態: 採用（PoC 関門合格）
- 日付: 2026-10-29

## 決定

BFF（Hono）は **Lambda Web Functions**（`nodejs24.x`、arm64）で動かす。`infra/config/options.ts` の `bffPlatform` 既定値は `'web-functions'`。

## 根拠

[PoC 関門](0000-poc-gate.md) の確認項目（CloudFront + OAC 経由の POST、SSE 逐次配信、ハートビートによる 120 秒超のストリーム、Cookie 転送、クライアント中断の検知、L1 デプロイと Revision 切り戻し）がすべて合格した。

## 構成のポイント

- アプリは `AWS_LAMBDA_HTTP_ENDPOINT` で listen する通常の HTTP サーバー（`@hono/node-server`）。エントリは `dist/api/index.js` + `{"type":"module"}`。
- コードは専用のバージョニング有効 S3 バケット（`lambda.amazonaws.com` に `GetObject/GetObjectVersion` を SourceArn 条件付きで許可）に置く。CDK bootstrap バケットは使えない。
- `CfnWebFunction` → `CfnWebFunctionRevision`（不変。置換時も **RETAIN** で旧版を保持）→ `CfnWebFunctionEndpoint`（`HomeRegion`、`IamAuth`、`revisionWeights`）。
- CloudFront は OAC（`lambda` / `always-amz-auth` / `sigv4`）+ `HttpOrigin(endpoint.attrDomainName)`、Origin Request Policy は `AllViewerExceptHostHeader`、読み取りタイムアウト 60 秒（SSE ハートビート 15 秒）。
- Web Function は `AddPermission` 非対応のため、`AWS::Lambda::ResourcePolicy` で当該 Distribution の ARN だけに `lambda:InvokeWebFunctionEndpoint` を許可する（循環参照を避けるため Frontend スタック側に置く）。
- `APP_ORIGIN` は CloudFront ドメインに依存するため、Frontend スタックが SSM パラメータに書き、BFF が起動時に読む（独自ドメイン時は固定値）。
- 最大実行時間 150 秒（生成上限 120 秒 < BFF 150 秒 < ロック 180 秒）。

## 代替（不合格時）

`bffPlatform: 'function-url'` で Lambda Function URL + Response Streaming + OAC に切り替えられる（`ApiStack` と `apps/api/src/server.ts` の `handler` のみが差分。CDK テストで構成を検証済み）。この場合、POST/PUT のボディハッシュ `x-amz-content-sha256` が必要なため、`pnpm deploy:aws` が `VITE_PAYLOAD_HASH_HEADER=true` でフロントをビルドする。

## 運用

- 切り戻し: `aws lambda-web update-web-function-endpoint --function-name <name> --endpoint-name <stage> --revision-weights revisionId=<旧ID>,weight=100`（約 7 秒で反映）。次回の `pnpm deploy:aws` で CloudFormation の状態に戻る。
- 旧 Revision は関数あたり 50 件までのため、不要になったものは `aws lambda-web delete-web-function-revision` で削除する。
- Web Function はアプリの起動失敗でも Revision が Active になるため、デプロイ後に必ず `pnpm smoke` を実行する。
