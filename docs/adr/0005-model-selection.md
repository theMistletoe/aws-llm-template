# ADR 0005: Bedrock モデルの選定

- 状態: 採用
- 日付: 2026-10-29

## 決定

- 既定モデル: **`jp.anthropic.claude-haiku-5-5`**（JP 推論プロファイル。推論は国内リージョン（東京・大阪）で実行。低コスト・低レイテンシ）。
- モデルID は `infra/config/app-config.ts`（`deploy.config.json` の `modelId` で上書き）に集約し、BFF と Runtime の環境変数・IAM（プロファイル ARN と転送先基盤モデル ARN のみ許可）に反映する。変更は git 履歴で監査できる。

## 背景

- データ所在の明確な要件はなく、コストと性能を優先して Global / JP 推論プロファイルも選定対象とした（§1.4 D1）。
- 東京で利用できる主な推論プロファイル（2026-10-29 確認）: `jp.anthropic.claude-haiku-5-5` / `jp.anthropic.claude-opus-5-5` / `global.anthropic.claude-sonnet-5-5` / `jp.anthropic.claude-haiku-4-5-20251001-v1:0` / `jp.anthropic.claude-sonnet-4-6` 等。

## 注意

- Claude 5 系はアカウントによって「not available for this account」となり、別途の有効化が必要な場合がある。今回の AWS dev 検証アカウントがこれに該当したため、dev 環境は同じ JP・Haiku 系で利用可能な **`jp.anthropic.claude-haiku-4-5-20251001-v1:0`** を `deploy.config.json` で指定して検証した。Claude 5 系が有効になれば `modelId` を戻すだけでよい。
- Strands の `BedrockModel` には `temperature` のみ指定する（`topP` を同時指定すると拒否するモデルがある）。
