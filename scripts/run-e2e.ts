import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { E2E_PORTS, launchStack } from '../local/launch';
import { ROOT, log, reset } from '../local/lib';
import { preflight } from '../local/preflight';

/**
 * System E2E の実行（§12.5）。e2e プロファイル（専用テーブル・専用ポート）でアプリ一式を起動し、
 * TesterArmy `e2e run` を実行して終了する。`--exploratory` でAI依存のテスト（要モデル設定）を実行する。
 */
const exploratory = process.argv.includes('--exploratory');
const passthrough = process.argv.slice(2).filter((a) => a !== '--exploratory');

function browsersInstalled(): boolean {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache/ms-playwright');
  return existsSync(dir) && readdirSync(dir).some((d) => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-'));
}

function run(command: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => done(code ?? 1));
  });
}

async function main(): Promise<number> {
  if (!browsersInstalled()) {
    log('Playwright の Chromium を取得します（初回のみ。Linuxでは `pnpm exec e2e-web install chromium --with-deps` が必要な場合があります）');
    const code = await run(resolve(ROOT, 'node_modules/.bin/e2e-web'), ['install', 'chromium']);
    if (code !== 0) return code;
  }
  await preflight({ ensureUp: true });
  await reset(['e2e']);
  const stack = await launchStack({ profile: 'e2e', ports: E2E_PORTS, logDir: resolve(ROOT, '.e2e/logs') });
  try {
    const config = exploratory ? 'e2e.exploratory.config.ts' : 'e2e.config.ts';
    return await run(resolve(ROOT, 'node_modules/.bin/e2e'), ['run', '--config', config, ...passthrough], {
      APP_URL: `http://localhost:${E2E_PORTS.web}`,
      E2E_TELEMETRY_DISABLED: '1',
    });
  } finally {
    await stack.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  },
);
