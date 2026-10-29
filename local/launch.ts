import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCAL_AWS_ENV, ROOT, log, seed, startProcess, stopProcess, tableNames, waitForHttp, type Profile } from './lib';
import { preflight } from './preflight';

export type StackPorts = { web: number; api: number; agent: number };
export const DEV_PORTS: StackPorts = { web: 5173, api: 3000, agent: 8080 };
export const E2E_PORTS: StackPorts = { web: 5174, api: 3001, agent: 8081 };

/**
 * web / api / agent をローカルで起動する（§11.1 `pnpm dev`）。
 * MiniStack が未起動なら起動し、テーブルを作成してから各プロセスを立ち上げる。
 */
export async function launchStack(options: { profile: Profile; ports: StackPorts; env?: Record<string, string>; logDir?: string }) {
  await preflight({ ensureUp: true });
  await seed([options.profile]);
  const tables = tableNames(options.profile);
  const appOrigin = process.env.APP_ORIGIN ?? `http://localhost:${options.ports.web}`;
  const children: ChildProcess[] = [];
  const tsx = resolve(ROOT, 'node_modules/.bin/tsx');

  children.push(
    startProcess('agent', tsx, ['apps/agent/src/main.local.ts'], {
      env: { ...LOCAL_AWS_ENV, APP_MODE: 'local', PORT: String(options.ports.agent), ...options.env },
      ...(options.logDir ? { logDir: options.logDir } : {}),
    }),
  );
  children.push(
    startProcess('api', tsx, ['apps/api/src/local.ts'], {
      env: {
        ...LOCAL_AWS_ENV,
        APP_MODE: 'local',
        PORT: String(options.ports.api),
        APP_ORIGIN: appOrigin,
        DATA_TABLE_NAME: tables.data,
        SESSION_TABLE_NAME: tables.session,
        LOCAL_AGENT_URL: `http://127.0.0.1:${options.ports.agent}`,
        ...options.env,
      },
      ...(options.logDir ? { logDir: options.logDir } : {}),
    }),
  );
  children.push(
    startProcess('web', resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['--port', String(options.ports.web), '--strictPort'], {
      cwd: resolve(ROOT, 'apps/web'),
      env: { WEB_PORT: String(options.ports.web), API_PROXY_TARGET: `http://127.0.0.1:${options.ports.api}` },
      ...(options.logDir ? { logDir: options.logDir } : {}),
    }),
  );

  const stop = async () => {
    await Promise.all(children.map((c) => stopProcess(c)));
  };
  const ready = await Promise.all([
    waitForHttp(`http://127.0.0.1:${options.ports.agent}/ping`, 60_000),
    waitForHttp(`http://127.0.0.1:${options.ports.api}/api/health`, 60_000),
    waitForHttp(`http://127.0.0.1:${options.ports.web}/`, 60_000),
  ]);
  if (ready.includes(false)) {
    await stop();
    throw new Error(`起動に失敗しました（agent/api/web の準備状況: ${ready.join('/')}）`);
  }
  log(`ready: web http://localhost:${options.ports.web}  api :${options.ports.api}  agent :${options.ports.agent}  (APP_ORIGIN=${appOrigin})`);
  return { stop, children, appOrigin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchStack({ profile: 'local', ports: DEV_PORTS })
    .then(({ stop }) => {
      log('ローカルログインはメールアドレスを入力し、確認コード 000000 を使ってください（dev-auth）');
      const shutdown = () => {
        log('停止しています…');
        void stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
}
