import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** デプロイオプション（§9.2）。任意機能は既定OFF */
export type DeployOptions = {
  region: 'ap-northeast-1';
  stage: string;
  enableWaf: boolean;
  enableBudgets: boolean;
  enableCiCd: boolean;
  useCustomDomain: boolean;
  /** 標準true */
  webSearchEnabled: boolean;
  /** PoC不合格時の代替 */
  bffPlatform: 'web-functions' | 'function-url';
};

export const defaultDeployOptions: DeployOptions = {
  region: 'ap-northeast-1',
  stage: 'dev',
  enableWaf: false,
  enableBudgets: false,
  enableCiCd: false,
  useCustomDomain: false,
  webSearchEnabled: true,
  bffPlatform: 'web-functions',
};

/** 環境ごとの値（メールアドレス・ドメイン等）。git管理外の infra/deploy.config.json か環境変数で与える */
export type DeploySettings = DeployOptions & {
  /** PoC用の診断エンドポイント（SSE長時間接続の確認）。既定false。検証後は必ずOFFに戻す */
  enableDiagnostics?: boolean;
  sesFromEmail: string;
  createSesIdentity: boolean;
  alarmEmail?: string;
  budgetMonthlyUsd: number;
  budgetEmail?: string;
  githubRepository?: string;
  customDomainName?: string;
  customDomainCertificateArn?: string;
  modelId: string;
};

const here = dirname(fileURLToPath(import.meta.url));
export const DEPLOY_CONFIG_PATH = resolve(here, '../deploy.config.json');

const bool = (v: unknown, fallback: boolean) =>
  v === undefined || v === '' ? fallback : v === true || v === 'true' || v === '1';

export function loadDeploySettings(env: NodeJS.ProcessEnv = process.env, file = DEPLOY_CONFIG_PATH): DeploySettings {
  const json: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const get = (key: string, envKey: string) => env[envKey] ?? (json[key] as string | boolean | number | undefined);
  const stage = String(get('stage', 'CHAT_APP_STAGE') ?? defaultDeployOptions.stage);
  if (!/^[a-z][a-z0-9]{1,9}$/.test(stage)) throw new Error(`stage must match ^[a-z][a-z0-9]{1,9}$ (got ${stage})`);
  const bffPlatform = String(get('bffPlatform', 'CHAT_APP_BFF_PLATFORM') ?? defaultDeployOptions.bffPlatform);
  if (bffPlatform !== 'web-functions' && bffPlatform !== 'function-url') throw new Error('bffPlatform must be web-functions or function-url');
  const settings: DeploySettings = {
    region: 'ap-northeast-1',
    stage,
    enableWaf: bool(get('enableWaf', 'CHAT_APP_ENABLE_WAF'), false),
    enableBudgets: bool(get('enableBudgets', 'CHAT_APP_ENABLE_BUDGETS'), false),
    enableCiCd: bool(get('enableCiCd', 'CHAT_APP_ENABLE_CICD'), false),
    useCustomDomain: bool(get('useCustomDomain', 'CHAT_APP_USE_CUSTOM_DOMAIN'), false),
    webSearchEnabled: bool(get('webSearchEnabled', 'CHAT_APP_WEB_SEARCH_ENABLED'), true),
    bffPlatform,
    sesFromEmail: String(get('sesFromEmail', 'CHAT_APP_SES_FROM_EMAIL') ?? 'no-reply@example.com'),
    createSesIdentity: bool(get('createSesIdentity', 'CHAT_APP_CREATE_SES_IDENTITY'), false),
    budgetMonthlyUsd: Number(get('budgetMonthlyUsd', 'CHAT_APP_BUDGET_USD') ?? 50),
    modelId: String(get('modelId', 'CHAT_APP_MODEL_ID') ?? 'jp.anthropic.claude-haiku-5-5'),
    enableDiagnostics: bool(get('enableDiagnostics', 'CHAT_APP_ENABLE_DIAGNOSTICS'), false),
  };
  const optional = (key: keyof DeploySettings, envKey: string) => {
    const v = get(key, envKey);
    if (v !== undefined && v !== '') (settings as Record<string, unknown>)[key] = String(v);
  };
  optional('alarmEmail', 'CHAT_APP_ALARM_EMAIL');
  optional('budgetEmail', 'CHAT_APP_BUDGET_EMAIL');
  optional('githubRepository', 'CHAT_APP_GITHUB_REPOSITORY');
  optional('customDomainName', 'CHAT_APP_CUSTOM_DOMAIN');
  optional('customDomainCertificateArn', 'CHAT_APP_CUSTOM_DOMAIN_CERT_ARN');
  if (settings.useCustomDomain && (!settings.customDomainName || !settings.customDomainCertificateArn)) {
    throw new Error('useCustomDomain=true requires customDomainName and customDomainCertificateArn (us-east-1)');
  }
  if (settings.enableBudgets && !settings.budgetEmail) throw new Error('enableBudgets=true requires budgetEmail');
  if (settings.enableCiCd && !settings.githubRepository) throw new Error('enableCiCd=true requires githubRepository (owner/repo)');
  return settings;
}
