import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { streamHandle } from '@hono/aws-lambda';
import { serve } from '@hono/node-server';
import { CognitoOtpAuthProvider } from '@ai-chat/auth/cognito';
import { loadApiConfig, type ApiConfig } from '@ai-chat/config';
import { createApp } from './app';
import { buildDeps } from './deps-factory';

/**
 * AWSアダプター（APP_MODE=aws）。Hono本体（app.ts）は共通で、実行基盤の差分はここに閉じ込める（§9.4）。
 * - web-functions: Lambda Web Functions。AWS_LAMBDA_HTTP_ENDPOINT でHTTPサーバーを起動する
 * - function-url : Lambda Function URL + Response Streaming。`handler` をエクスポートする
 */

function cached<T>(load: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let value: { v: T; at: number } | undefined;
  let inflight: Promise<T> | undefined;
  return async () => {
    if (value && Date.now() - value.at < ttlMs) return value.v;
    inflight ??= load()
      .then((v) => {
        value = { v, at: Date.now() };
        return v;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

export function createAwsApp(env: NodeJS.ProcessEnv = process.env) {
  const config: ApiConfig = loadApiConfig(env);
  if (config.mode !== 'aws' || config.auth.backend !== 'cognito') {
    throw new Error('server.ts must run with APP_MODE=aws and AUTH_BACKEND=cognito');
  }
  const { userPoolId, clientId, clientSecretId } = config.auth;
  const secrets = new SecretsManagerClient({ region: config.region });
  const getClientSecret = cached(async () => {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: clientSecretId }));
    if (!res.SecretString) throw new Error('Cognito client secret is empty');
    return res.SecretString;
  }, 10 * 60_000);

  const ssm = new SSMClient({ region: config.region });
  const resolveAppOrigin = config.appOrigin
    ? async () => config.appOrigin!
    : cached(async () => {
        const res = await ssm.send(new GetParameterCommand({ Name: config.appOriginParameter! }));
        const value = res.Parameter?.Value?.replace(/\/+$/, '');
        if (!value?.startsWith('https://')) throw new Error('APP_ORIGIN parameter must be an https URL');
        return value;
      }, 5 * 60_000);

  const auth = new CognitoOtpAuthProvider({ region: config.region, userPoolId, clientId, getClientSecret });
  return createApp(buildDeps(config, { auth, resolveAppOrigin }));
}

const app = createAwsApp();

/** Function URL（RESPONSE_STREAM）用ハンドラ。Lambda の通常ランタイムでのみ生成する（Web Functions には awslambda がない） */
const lambdaRuntime = (globalThis as { awslambda?: { streamifyResponse?: unknown } }).awslambda;
export const handler: ReturnType<typeof streamHandle> | undefined =
  typeof lambdaRuntime?.streamifyResponse === 'function' ? streamHandle(app) : undefined;

/** Web Functions: ランタイムが指定するアドレスでlistenする */
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
if (endpoint) {
  const sep = endpoint.lastIndexOf(':');
  serve({ fetch: app.fetch, hostname: endpoint.slice(0, sep), port: Number(endpoint.slice(sep + 1)) });
  process.on('SIGTERM', () => process.exit(0));
}
