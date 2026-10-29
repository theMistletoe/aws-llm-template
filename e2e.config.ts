import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

/**
 * System E2E（§12.5）: ブラウザ → Vite Proxy → Hono → MiniStack + ローカルStrands/固定モデル/検索fixture。
 * アプリは scripts/run-e2e.ts が e2e プロファイル（専用テーブル・専用ポート）で起動してから実行する。
 * deterministic な操作・検証のみ（AI依存の agent.act 等は e2e.exploratory.config.ts）。
 */
const url = process.env.APP_URL ?? 'http://localhost:5174';

export default {
  tests: 'tests/e2e/**/*.e2e.ts',
  targets: [
    {
      name: 'chromium',
      engine: web({ browser: 'chromium', locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 800 } }),
      app: { url, readyUrl: `${url}/api/health` },
    },
  ],
  timeout: 90_000,
  actionTimeout: 15_000,
  assertionTimeout: 15_000,
  retries: 0,
  workers: 1,
  output: '.e2e',
  trace: 'retain-on-failure',
  video: 'off',
  reporters: ['list', 'junit'],
  cache: 'off',
} satisfies E2EConfig;
