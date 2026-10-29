# Definition of Done の達成状況

仕様書（`PRD/ai_chat_starter_kit_technical_spec_v2_1.md`）末尾の MVP 完成条件に対する状況（2026-10-29 時点）。

| # | 条件 | 状況 | 根拠 |
|---|---|---|---|
| 1 | TypeScript 統一、`pnpm lint`、`pnpm typecheck`、lockfile 固定 | ✅ | フロント・API・エージェント・IaC・テスト・スクリプトすべて TypeScript。`pnpm-lock.yaml`、ESLint flat config、`tsc -b` |
| 2 | AWS アカウント/APIキーなしで `pnpm install && pnpm test` が通り、`pnpm dev` で MiniStack + Web + Hono + ローカル AgentRunner が起動 | ✅ | `scripts/test-all.ts`、`local/launch.ts`（初回の依存・Dockerイメージ・Chromium の取得を除く） |
| 3 | `pnpm test` でフロント Unit、バック Unit、API 結合、TesterArmy `e2e` が全てパス | ✅ | Unit 245件（web 46 / api 81 / agent 29 / packages 68 / infra 21）、結合 24件、E2E 13件 |
| 4 | PoC 関門の合否と採用した BFF 実行基盤が ADR に記録 | ✅ | [ADR 0000](adr/0000-poc-gate.md)、[ADR 0001](adr/0001-bff-platform.md) |
| 5 | メールとコードだけの新規登録/ログイン（1画面、新規はメール1通）が AWS dev で動作し、登録有無が推測できず、トークンが露出しない | ✅ | AWS-01（`pnpm test:aws-smoke`）、ADR 0000 Cognito 節 |
| 6 | Chat CRUD・所有者分離・クォータ（日次/時間別/検索）・冪等性・遅延回復をテスト済み | ✅ | `apps/api` のユニット、`tests/integration/*`、AWS-07 |
| 7 | AgentCore Runtime（会話単位セッション）+ Strands TS + 選定モデル + Gateway WebSearch が東京リージョンで動く | ✅（モデル注記あり） | AWS-04/05/06/08。既定モデル `jp.anthropic.claude-haiku-5-5` は検証アカウントで未提供のため dev は `jp.anthropic.claude-haiku-4-5-20251001-v1:0` で検証（ADR 0005） |
| 8 | Web 検索結果の出典タイトル・URL・公開日を安全に表示 | ✅ | フロント Unit（XSS・URLスキーム）、E2E（web-search.e2e.ts）、AWS-05 |
| 9 | AgentCore→BFF→CloudFront→React の SSE 逐次配信/ハートビート/中断/失敗の整合性を検証 | ✅ | AWS-03、125秒ハートビート PoC、結合・E2E（切断・失敗・429） |
| 10 | 任意機能 OFF で動作し、個別 ON が既存に影響せず追加可能 | ✅（ON は synth のみ） | OFF の AWS dev 稼働、`infra/test/stacks.test.ts`（WAF/Budgets/CI/独自ドメイン/Function URL の構成検証） |
| 11 | README、プライバシーポリシー雛形、削除スクリプト、独自ドメイン移行手順 | ✅ | `README.md`、`docs/privacy-policy-template.md`、`scripts/delete-user.ts`（AWS dev で実行確認）、`docs/custom-domain-migration.md` |

## 未実施・今後の課題

- SES サンドボックス解除の申請（キット利用者が本番公開前に実施）。
- AgentCore のアイドルタイムアウトによる解放の実測、AWS 上でクォータ上限まで使い切る試験、任意機能（WAF/Budgets/CI）の AWS への実適用。
- Claude 5 系モデルのアカウント有効化（有効化後は `modelId` を既定値へ戻す）。
- Web Search connector の版固定（CloudFormation 非対応。必要ならカスタムリソース化）。
