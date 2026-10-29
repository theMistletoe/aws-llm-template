# ADR 0004: ローカル基盤とテスト（MiniStack + TesterArmy e2e）

- 状態: 採用
- 日付: 2026-10-29

## 決定

- ローカル AWS は **MiniStack 1.5.33**（`ministackorg/ministack:1.5.33@sha256:b58186186515a372798ccf0ca9975c295db219b5a811975337d6967b968e07b4`）を docker compose で起動し、DynamoDB のみ使う（`SERVICES=dynamodb,sts`）。CDK は MiniStack にデプロイしない。テーブルは `local/lib.ts` が SDK で作る（CDK の DataStack と同じキー設計）。
- プロファイルでテーブルを分離: `local`（開発データ）/ `test`（API結合）/ `e2e`（E2E）。`pnpm test` は test と e2e だけを作り直す。
- ローカルの AI は `FixedModelProvider`（Strands の `Model` を継承した決定的モデル）と検索 fixture。Strands のカスタムモデルプロバイダは 1.22.0 で動作を確認した（AgentRunner 層での差し替えは不要）。
- System E2E は **TesterArmy `e2e@0.21.3` + `@e2e-dev/web@0.15.3`**（Playwright 1.64.1 のローカル Chromium）。決定的なロケータ・アサーションのみで、`agent.act` 等は `test:e2e:exploratory` に分離。
- E2E は専用ポート（web 5174 / api 3001 / agent 8081）で `scripts/run-e2e.ts` が一式を起動してから `e2e run` する。
- pnpm 12 は公開から1日未満の版を既定で拒否するため、依存は公開から1日以上経過した版に固定した（AWS SDK は 3.1157.0）。

## 留意点（調査・実装で判明）

- MiniStack は状態をグレースフル停止時にのみ保存する（`docker kill` では失われる）。TTL の掃除は60秒間隔。署名リージョンとアクセスキー（12桁数字は別アカウント扱い）でデータが分かれるため、`ap-northeast-1` と `test` キーに統一した。
- `e2e` の `app.url` は平文 HTTP の場合ループバックのみ許可。`CI=1` で retries=1 / workers=1 になる。テレメトリは `E2E_TELEMETRY_DISABLED=1` で無効化。
- Linux では Chromium に OS ライブラリが必要（`pnpm exec e2e-web install chromium --with-deps`）。
- msw 3 では未定義リクエストの扱いが `onUnhandledFrame` に改名されている（`onUnhandledRequest` は無視される）。
