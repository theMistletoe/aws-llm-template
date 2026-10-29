import { pathToFileURL } from 'node:url';
import { composeUp, dockerAvailable, log, ministackHealthy, waitFor } from './lib';

/**
 * Docker と MiniStack の確認（§12.7 手順1-2）。
 * ensureUp=true の場合、MiniStack が未起動なら起動し、タイムアウト付きで待機する。
 */
export async function preflight(options: { ensureUp: boolean; timeoutMs?: number } = { ensureUp: true }): Promise<void> {
  if (await ministackHealthy()) {
    log('MiniStack: 起動済み');
    return;
  }
  const docker = dockerAvailable();
  if (!docker.ok) {
    throw new Error(`[preflight] ${docker.reason}`);
  }
  if (!options.ensureUp) throw new Error('[preflight] MiniStack が起動していません。`pnpm infra:local:up` を実行してください。');
  composeUp();
  const ok = await waitFor(() => ministackHealthy(), options.timeoutMs ?? 90_000);
  if (!ok) throw new Error('[preflight] MiniStack のヘルスチェックがタイムアウトしました（http://localhost:4566/_ministack/health）');
  log('MiniStack: 起動しました');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preflight({ ensureUp: process.argv.includes('--up') }).catch((e: Error) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
