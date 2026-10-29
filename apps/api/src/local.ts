import { serve, type ServerType } from '@hono/node-server';
import { DevOtpAuthProvider } from '@ai-chat/auth/dev';
import { loadApiConfig } from '@ai-chat/config';
import { pathToFileURL } from 'node:url';
import { createApp } from './app';
import { buildDeps } from './deps-factory';

/**
 * ローカルアダプター（APP_MODE=local）: MiniStack + ローカルAgent + dev-auth。
 * dev-authはこのエントリからのみ参照し、本番エントリ（server.ts）のバンドルには含めない（§1.5）。
 */
export const LOCAL_API_DEFAULTS: Record<string, string> = {
  APP_MODE: 'local',
  APP_ORIGIN: 'http://localhost:5173',
  AWS_REGION: 'ap-northeast-1',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_EC2_METADATA_DISABLED: 'true',
  DATA_TABLE_NAME: 'chat-app-local-data',
  SESSION_TABLE_NAME: 'chat-app-local-session',
  AUTH_BACKEND: 'dev-auth',
  AGENT_BACKEND: 'local-strands',
  LOCAL_AGENT_URL: 'http://localhost:8080',
  MODEL_ID: 'local-fixed-model',
};

export function startLocalApi(options: { port: number; env?: Record<string, string | undefined> }): Promise<ServerType> {
  const env = { ...LOCAL_API_DEFAULTS, ...options.env };
  const config = loadApiConfig(env);
  const appOrigin = config.appOrigin!;
  const deps = buildDeps(config, { auth: new DevOtpAuthProvider(), resolveAppOrigin: async () => appOrigin });
  const app = createApp(deps);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: '127.0.0.1' }, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const env = Object.fromEntries(Object.keys(LOCAL_API_DEFAULTS).filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  startLocalApi({ port, env: { ...env, ...pickEnv(process.env) } }).then(() => {
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'api_listening', port })}\n`);
  });
}

function pickEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
}
