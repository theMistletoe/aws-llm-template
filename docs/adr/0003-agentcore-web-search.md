# ADR 0003: AgentCore Runtime + Gateway Web Search

- 状態: 採用
- 日付: 2026-10-29

## 決定

- Strands Agents TypeScript SDK のエージェントを **AgentCore Runtime（Node.js direct code deployment, `NODE_22`, arm64）** で動かす。`apps/agent/src/main.ts` を esbuild で ESM 単一ファイル（`app.js` + `{"type":"module"}`）にし ZIP 化。CDK の `s3_assets.Asset`（コンテンツハッシュ付きキー）で保管し、`CfnRuntime` に渡す。
  - Strands SDK が `import.meta.url` を使うため CJS ではなく ESM でバンドルする。
  - BFF（Node 24）とはビルドターゲットを分ける。
- サービス契約: `GET /ping`（`Healthy` / `HealthyBusy`）、`POST /invocations`（AgentEvent を SSE で返す。15秒無通信でコメント行を送る）。
- 会話ごとに1セッション: `runtimeSessionId = chat-<chatId>-<sha256(userSub)の先頭16桁>`（48文字）。アイドル300秒、最大8時間。会話削除・中断・タイムアウト時に `StopRuntimeSession`。
- **Web Search**: AgentCore Gateway（MCP、inbound `AWS_IAM`、`supportedVersions: 2025-11-25 / 2025-06-18 / 2025-03-26`）に connector target `web-search` を追加。
  - モデルに公開するツールは自前の `web_search` だけ。その中で Strands の `McpClient`（SigV4署名した fetch）を使い、`tools/list` から `…___WebSearch` のみを許可して呼ぶ。回数（3回/回答）・クエリ長（200文字）・タイムアウト・件数・拒否ドメイン・スニペット長をここで強制する。
  - 出典イベントは検索ツールの実結果からのみ生成する（モデルが書いた出典は使わない）。

## 制約

| 事項 | 内容 | 対応 |
|---|---|---|
| connector の版 | `CfnGatewayTarget` / CloudFormation の `ConnectorSource` は `connectorId` のみで、版（`1.2.0`）を指定できない | CloudFormation の既定版（2026-10 時点で 1.3.0）を使う。1.3.0 は MCP のツール注釈の追加のみで、入力（`query`, `maxResults`, `filters`）・出力（`results[].title/url/text/publishedDate`）は 1.2.0 と互換。版を固定したい場合は `CreateGatewayTarget` を呼ぶカスタムリソースに置き換える |
| MCP クライアント | `@modelcontextprotocol/client` v2 は最初に `server/discover`（2026-07-28）を送り、未対応なら `initialize`（2025-11-25）にフォールバックする | Gateway の `supportedVersions` に 2025-11-25 を含める。ユニットテストで偽 MCP サーバーに対するフォールバックを確認 |
| ツール名フィルタ | Strands の RegExp フィルタは先頭アンカーで評価される | `/^(?:[A-Za-z0-9-]+___)?WebSearch$/` |
| IAM | 推論プロファイルは転送先リージョンの基盤モデル ARN の許可も必要 | プロファイル ARN と `foundation-model/<base>` を全リージョンで許可（選定モデルのみ） |

## PoC関門（AWS dev）の結果

[0000-poc-gate.md](0000-poc-gate.md) を参照。
