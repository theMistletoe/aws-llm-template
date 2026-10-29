import { spawn } from 'node:child_process';
import { ROOT, log, reset, seed } from '../local/lib';
import { preflight } from '../local/preflight';

/**
 * `pnpm test` の実体（§12.7）。
 * 1. preflight（Docker確認） 2. MiniStack未起動なら起動・待機 3. reset → seed
 * 4. lint → typecheck → test:unit → test:integration → test:e2e
 * 5. MiniStack は起動したまま終了（停止は `pnpm infra:local:down`）
 */
const steps: Array<[string, string[]]> = [
  ['lint', ['run', 'lint']],
  ['typecheck', ['run', 'typecheck']],
  ['test:unit', ['run', 'test:unit']],
  ['test:integration', ['run', 'test:integration']],
  ['test:e2e', ['run', 'test:e2e']],
];

function pnpm(args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn('pnpm', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' } });
    child.on('exit', (code) => done(code ?? 1));
  });
}

async function main(): Promise<number> {
  const started = Date.now();
  await preflight({ ensureUp: true });
  await reset(['test', 'e2e']);
  await seed(['local']);
  for (const [name, args] of steps) {
    log(`▶ ${name}`);
    const t = Date.now();
    const code = await pnpm(args);
    if (code !== 0) {
      log(`✖ ${name} が失敗しました（exit ${code}）`);
      return code;
    }
    log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
  log(`すべて成功しました（${((Date.now() - started) / 1000).toFixed(0)}s）。MiniStack は起動したままです（停止: pnpm infra:local:down）`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  },
);
