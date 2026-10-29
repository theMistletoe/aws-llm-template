import { serve, type ServerType } from '@hono/node-server';
import { loadAgentConfig } from '@ai-chat/config';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentApp } from './app';
import { FixedModelProvider } from './fixed-model';
import { FixtureWebSearchProvider } from './mock-web-search';
import { createStrandsRunner } from './strands-runner';

/** ローカル用エントリ（APP_MODE=local）: 固定モデル + 検索fixture。AWS・外部LLM・ネットワークを使わない */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../../../local/fixtures/search', import.meta.url));

export function startLocalAgent(options: { port: number; env?: Record<string, string | undefined> }): Promise<ServerType> {
  const config = loadAgentConfig({
    APP_MODE: 'local',
    MODEL_PROVIDER: 'fixed',
    SEARCH_BACKEND: 'fixture',
    ...options.env,
  });
  const runner = createStrandsRunner({
    createModel: () => new FixedModelProvider({ chunkDelayMs: config.model.fixedChunkDelayMs }),
    ...(config.search.enabled
      ? { search: new FixtureWebSearchProvider(config.search.fixturesDir ?? DEFAULT_FIXTURES_DIR) }
      : {}),
    limits: config.search,
    inputBudgetChars: config.inputBudgetChars,
  });
  const app = createAgentApp({ runner, ...(options.env?.AGENT_HEARTBEAT_MS ? { heartbeatMs: Number(options.env.AGENT_HEARTBEAT_MS) } : {}) });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: '127.0.0.1' }, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  startLocalAgent({ port, env }).then(() => {
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'agent_listening', port })}\n`);
  });
}
