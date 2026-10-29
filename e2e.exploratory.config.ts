import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';

/**
 * 探索的E2E（`pnpm test:e2e:exploratory`）。`agent.act` 等のAI依存ステップを使うため `pnpm test` には含めない（§11.2）。
 * 実行には AI SDK とモデルの資格情報が必要:
 *   pnpm add -D -w ai@7
 *   export AI_GATEWAY_API_KEY=...            # Vercel AI Gateway の例
 *   export E2E_AGENT_MODEL=anthropic/claude-sonnet-5-5
 */
const moduleName = 'ai';
let gateway: (model: string) => unknown;
try {
  ({ gateway } = (await import(moduleName)) as { gateway: (model: string) => unknown });
} catch {
  throw new Error('探索的E2Eには `pnpm add -D -w ai@7` とモデルの資格情報（例: AI_GATEWAY_API_KEY）が必要です');
}

export default {
  ...base,
  tests: 'tests/e2e-exploratory/**/*.e2e.ts',
  agents: { default: { model: gateway(process.env.E2E_AGENT_MODEL ?? 'anthropic/claude-sonnet-5-5') } },
  cache: 'read-write',
} as E2EConfig;
