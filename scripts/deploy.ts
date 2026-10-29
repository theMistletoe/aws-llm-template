import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeploySettings } from '../infra/config/options';
import { ROOT, log } from '../local/lib';
import { buildAgent } from './build-agent';
import { buildApi } from './build-api';

/**
 * AWS dev/prod への手動デプロイ（§11.3）。CI/CD は既定OFF。
 *   pnpm deploy:aws                     # ビルド → cdk deploy --all
 *   pnpm deploy:aws -- --stacks Data    # 一部のスタックのみ（ChatApp-<stage>-<名前>）
 *   pnpm deploy:aws -- --skip-build
 * 事前に IAM Identity Center 等でログインし、infra/deploy.config.json を用意しておくこと。
 */
function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, stdio: 'inherit', env: { ...process.env, ...options.env } });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} exited with ${code}`))));
  });
}

async function main() {
  const settings = loadDeploySettings();
  const argv = process.argv.slice(2);
  const stacksArg = argv.indexOf('--stacks');
  const stacks =
    stacksArg === -1 ? ['--all'] : (argv[stacksArg + 1] ?? '').split(',').map((s) => `ChatApp-${settings.stage}-${s.trim()}`);
  if (!argv.includes('--skip-build')) {
    log('build: web');
    await run('pnpm', ['--filter', 'web', 'build'], {
      env: settings.bffPlatform === 'function-url' ? { VITE_PAYLOAD_HASH_HEADER: 'true' } : {},
    });
    log('build: api');
    await buildApi();
    log('build: agent');
    await buildAgent();
  }
  log(`cdk deploy (stage=${settings.stage}, bffPlatform=${settings.bffPlatform})`);
  const outputs = resolve(ROOT, 'infra/cdk-outputs.json');
  const latest = resolve(ROOT, 'infra/cdk-outputs.latest.json');
  await run(resolve(ROOT, 'infra/node_modules/.bin/cdk'), ['deploy', ...stacks, '--require-approval', 'never', '--outputs-file', latest], {
    cwd: resolve(ROOT, 'infra'),
  });
  // 一部のスタックだけデプロイした場合も他スタックの出力を残す
  const read = (file: string) =>
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>) : {};
  const merged = { ...read(outputs), ...read(latest) };
  writeFileSync(outputs, `${JSON.stringify(merged, null, 2)}\n`);
  rmSync(latest, { force: true });
  const url = merged[`ChatApp-${settings.stage}-Frontend`]?.AppUrl;
  if (url) log(`アプリURL: ${url}`);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
