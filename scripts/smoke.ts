import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeploySettings } from '../infra/config/options';
import { ROOT } from '../local/lib';

/**
 * デプロイ後の簡易スモークテスト（ログイン不要）。
 *   pnpm smoke                      # infra/cdk-outputs.json の AppUrl を使う
 *   APP_URL=https://xxx.cloudfront.net pnpm smoke
 * - SPA と API のパス分離（SPA rewrite が /api/* と拡張子付きファイルに効かない）
 * - セキュリティヘッダー、APIのキャッシュ無効、Originチェック
 * - BFF（Web Function エンドポイント）へ直接アクセスできない（CloudFront OAC 経由のみ）
 */
type Check = { name: string; run: () => Promise<void> };

function outputs(): Record<string, Record<string, string>> {
  const file = resolve(ROOT, 'infra/cdk-outputs.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main(): Promise<number> {
  const settings = loadDeploySettings();
  const out = outputs();
  const appUrl = (process.env.APP_URL ?? out[`ChatApp-${settings.stage}-Frontend`]?.AppUrl ?? '').replace(/\/+$/, '');
  const bffDomain = out[`ChatApp-${settings.stage}-Api`]?.WebFunctionEndpointDomain;
  if (!appUrl) throw new Error('APP_URL が分かりません（infra/cdk-outputs.json か APP_URL を指定）');

  const checks: Check[] = [
    {
      name: 'SPA index.html とセキュリティヘッダー',
      run: async () => {
        const res = await fetch(`${appUrl}/`);
        assert(res.status === 200, `status ${res.status}`);
        assert((await res.text()).includes('<div id="root">'), 'index.html ではありません');
        assert(res.headers.get('content-security-policy')?.includes("default-src 'self'"), 'CSP がありません');
        assert(res.headers.get('strict-transport-security'), 'HSTS がありません');
        assert(res.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options がありません');
      },
    },
    {
      name: '/chat/:id の直アクセスは index.html（SPA rewrite）',
      run: async () => {
        const res = await fetch(`${appUrl}/chat/01JBQ7Z8X9Y0ABCDEFGHJKMNPQ`);
        assert(res.status === 200 && (await res.text()).includes('<div id="root">'), `status ${res.status}`);
      },
    },
    {
      name: '存在しない静的アセットは index.html に書き換えない',
      run: async () => {
        const res = await fetch(`${appUrl}/assets/does-not-exist.js`);
        assert(res.status === 403 || res.status === 404, `status ${res.status}`);
      },
    },
    {
      name: '/api/health（キャッシュ無効）',
      run: async () => {
        const res = await fetch(`${appUrl}/api/health`);
        assert(res.status === 200, `status ${res.status}`);
        assert(JSON.stringify(await res.json()) === '{"status":"ok"}', 'body');
        assert(res.headers.get('cache-control') === 'no-store', `cache-control ${res.headers.get('cache-control')}`);
        assert(res.headers.get('x-request-id'), 'x-request-id');
      },
    },
    {
      name: '存在しないAPIはJSONの404（index.htmlに潰さない）',
      run: async () => {
        const res = await fetch(`${appUrl}/api/does-not-exist`);
        assert(res.status === 404, `status ${res.status}`);
        assert(((await res.json()) as { error: { code: string } }).error.code === 'NOT_FOUND', 'code');
      },
    },
    {
      name: '未認証は401',
      run: async () => {
        const res = await fetch(`${appUrl}/api/v1/chats`);
        assert(res.status === 401, `status ${res.status}`);
      },
    },
    {
      name: 'Originなし・別Originの状態変更は403',
      run: async () => {
        const body = JSON.stringify({ email: 'smoke@example.com' });
        const none = await fetch(`${appUrl}/api/auth/otp/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        assert(none.status === 403, `no origin: ${none.status}`);
        const evil = await fetch(`${appUrl}/api/auth/otp/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body,
        });
        assert(evil.status === 403, `evil origin: ${evil.status}`);
      },
    },
  ];
  if (bffDomain) {
    checks.push({
      name: 'BFFエンドポイントへの直接アクセスは拒否（CloudFront OAC経由のみ）',
      run: async () => {
        const res = await fetch(`https://${bffDomain}/api/health`);
        assert(res.status === 403 || res.status === 401, `status ${res.status}`);
      },
    });
  }

  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      process.stdout.write(`✔ ${c.name}\n`);
    } catch (e) {
      failed++;
      process.stdout.write(`✖ ${c.name}: ${(e as Error).message}\n`);
    }
  }
  process.stdout.write(`\n${appUrl}: ${checks.length - failed}/${checks.length} passed\n`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  },
);
