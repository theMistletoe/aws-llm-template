import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Backend API 結合テスト（§12.4）: 実HTTP → Hono → MiniStack(DynamoDB) → ローカルAgent → 検索fixture */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
