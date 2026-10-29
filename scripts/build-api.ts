import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../local/lib';

/**
 * BFF（apps/api/src/server.ts）を Node.js 24 / ESM の単一ファイルにバンドルする。
 * 出力: dist/api/index.js（Web Functions は index.js を起動、Function URL は index.handler）
 * fail-closed: dev-auth・ローカル専用コードがバンドルに含まれていないことを検査する（§1.5）。
 */
export const FORBIDDEN_IN_PRODUCTION = [
  '__AI_CHAT_DEV_AUTH_PROVIDER_MUST_NOT_SHIP__',
  'ローカル固定モデルの応答です',
  'LOCAL_API_DEFAULTS',
];

export async function buildApi(outDir = resolve(ROOT, 'dist/api')) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [resolve(ROOT, 'apps/api/src/server.ts')],
    outfile: resolve(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  writeFileSync(resolve(outDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
  const bundle = readFileSync(resolve(outDir, 'index.js'), 'utf8');
  for (const marker of FORBIDDEN_IN_PRODUCTION) {
    if (bundle.includes(marker)) throw new Error(`本番バンドルにローカル専用コードが含まれています: ${marker}`);
  }
  return outDir;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  buildApi().then((dir) => process.stdout.write(`[build-api] ${dir}\n`));
}
