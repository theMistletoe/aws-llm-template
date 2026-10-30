import type { ServerType } from '@hono/node-server';
import { startLocalAgent } from '../../apps/agent/src/main.local';
import { startLocalApi } from '../../apps/api/src/local';
import { LOCAL_AWS_ENV, reset } from '../../local/lib';
import { preflight } from '../../local/preflight';
import { AGENT_PORT, API_ENV, API_PORT } from './env';

const close = (s: ServerType) => new Promise<void>((r) => s.close(() => r()));

/** MiniStackの準備待ち → テスト用テーブルのreset → Agent/APIを実ポートで起動 */
export default async function setup() {
  Object.assign(process.env, LOCAL_AWS_ENV);
  await preflight({ ensureUp: true });
  await reset(['test']);
  const agent = await startLocalAgent({ port: AGENT_PORT, env: { ...LOCAL_AWS_ENV, FIXED_MODEL_CHUNK_DELAY_MS: '5' } });
  const api = await startLocalApi({ port: API_PORT, env: { ...LOCAL_AWS_ENV, ...API_ENV } });
  return async () => {
    await Promise.all([close(api), close(agent)]);
  };
}
