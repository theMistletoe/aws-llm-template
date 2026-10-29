import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../local/lib';

/**
 * AgentCore Runtime 用（Node.js direct code deployment）に apps/agent/src/main.ts をバンドルし ZIP 化する。
 * AgentCore の Node ランタイム（NODE_22, arm64）向けにビルドターゲットを分ける（BFFは Node 24）。
 * 出力: dist/agent/app.js, dist/agent/package.json, dist/agent/agent.zip（entryPoint: app.js）
 */
const FORBIDDEN = ['ローカル固定モデルの応答です', 'fixture search failure', '__AI_CHAT_DEV_AUTH_PROVIDER_MUST_NOT_SHIP__'];

export async function buildAgent(outDir = resolve(ROOT, 'dist/agent')) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [resolve(ROOT, 'apps/agent/src/main.ts')],
    outfile: resolve(outDir, 'app.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  const pkg = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;
  writeFileSync(resolve(outDir, 'package.json'), pkg);
  const app = readFileSync(resolve(outDir, 'app.js'));
  for (const marker of FORBIDDEN) {
    if (app.includes(marker)) throw new Error(`Agentの本番バンドルにローカル専用コードが含まれています: ${marker}`);
  }
  const zip = zipSync(
    {
      'app.js': [new Uint8Array(app), { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }],
      'package.json': [new TextEncoder().encode(pkg), { mtime: new Date('2026-01-01T00:00:00Z') }],
    },
    {},
  );
  writeFileSync(resolve(outDir, 'agent.zip'), zip);
  return outDir;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  buildAgent().then((dir) => process.stdout.write(`[build-agent] ${dir}\n`));
}
