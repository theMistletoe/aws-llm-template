import { z } from 'zod';

/** 実行モード（§1.5）。local: MiniStack + ローカルAgent + dev-auth / aws: Cognito + AgentCore */
export type AppMode = 'local' | 'aws';
export type AgentBackend = 'local-strands' | 'agentcore';
export type SearchBackend = 'fixture' | 'agentcore-web-search';
export type AuthBackend = 'dev-auth' | 'cognito';
export type ModelProviderKind = 'fixed' | 'bedrock';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));

const int = (defaultValue: number, min = 0) => z.coerce.number().int().min(min).default(defaultValue);

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

/** 実行環境がAWSのマネージド実行基盤（Lambda / AgentCore）かどうか */
export function isManagedAwsRuntime(env: Env): boolean {
  return Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV || env.AGENTCORE_RUNTIME);
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ['localhost', '127.0.0.1', '::1', '[::1]', 'ministack', 'host.docker.internal'].includes(hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// BFF (apps/api)
// ---------------------------------------------------------------------------

const apiEnvSchema = z.object({
  APP_MODE: z.enum(['local', 'aws']),
  APP_ORIGIN: z.url().optional(),
  APP_ORIGIN_PARAMETER: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default('ap-northeast-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  DATA_TABLE_NAME: z.string().min(1),
  SESSION_TABLE_NAME: z.string().min(1),
  AUTH_BACKEND: z.enum(['dev-auth', 'cognito']),
  COGNITO_USER_POOL_ID: z.string().min(1).optional(),
  COGNITO_CLIENT_ID: z.string().min(1).optional(),
  COGNITO_CLIENT_SECRET_ID: z.string().min(1).optional(),
  AGENT_BACKEND: z.enum(['local-strands', 'agentcore']),
  LOCAL_AGENT_URL: z.url().default('http://localhost:8080'),
  AGENT_RUNTIME_ARN: z.string().min(1).optional(),
  AGENT_RUNTIME_QUALIFIER: z.string().min(1).default('DEFAULT'),
  MODEL_ID: z.string().min(1).default('jp.anthropic.claude-haiku-5-5'),
  WEB_SEARCH_ENABLED: bool(true),
  QUOTA_DAILY_REQUESTS: int(20, 1),
  QUOTA_HOURLY_REQUESTS: int(10, 1),
  QUOTA_DAILY_SEARCHES: int(20, 0),
  QUOTA_TIMEZONE: z.string().min(1).default('Asia/Tokyo'),
  USAGE_RETENTION_DAYS: int(90, 1),
  CONTEXT_TURNS: int(10, 0),
  MAX_TOOL_CALLS: int(3, 0),
  MAX_OUTPUT_TOKENS: int(2048, 1),
  GENERATION_TIMEOUT_MS: int(120_000, 1),
  AGENT_READ_TIMEOUT_MS: int(130_000, 1),
  BFF_MAX_DURATION_MS: int(150_000, 1),
  LOCK_TTL_SECONDS: int(180, 1),
  HEARTBEAT_INTERVAL_MS: int(15_000, 10),
  SESSION_ABSOLUTE_TTL_SECONDS: int(8 * 3600, 60),
  SESSION_IDLE_TTL_SECONDS: int(30 * 60, 60),
  SESSION_TOUCH_INTERVAL_SECONDS: int(60, 0),
  AUTH_FLOW_TTL_SECONDS: int(300, 30),
  OTP_COOLDOWN_SECONDS: int(60, 0),
  OTP_MAX_PER_HOUR: int(5, 1),
  AUTH_MIN_RESPONSE_MS: int(0, 0),
  DIAGNOSTICS_ENABLED: bool(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ApiConfig = {
  mode: AppMode;
  appOrigin?: string;
  appOriginParameter?: string;
  region: string;
  awsEndpointUrl?: string;
  tables: { data: string; session: string };
  auth:
    | { backend: 'dev-auth' }
    | { backend: 'cognito'; userPoolId: string; clientId: string; clientSecretId: string };
  agent:
    | { backend: 'local-strands'; url: string }
    | { backend: 'agentcore'; runtimeArn: string; qualifier: string };
  modelId: string;
  webSearchEnabled: boolean;
  quota: {
    dailyRequests: number;
    hourlyRequests: number;
    dailySearches: number;
    timeZone: string;
    retentionDays: number;
  };
  generation: {
    contextTurns: number;
    maxToolCalls: number;
    maxOutputTokens: number;
    timeoutMs: number;
    agentReadTimeoutMs: number;
    bffMaxDurationMs: number;
    lockTtlSeconds: number;
    heartbeatIntervalMs: number;
  };
  session: {
    absoluteTtlSeconds: number;
    idleTtlSeconds: number;
    touchIntervalSeconds: number;
    authFlowTtlSeconds: number;
  };
  otp: { cooldownSeconds: number; maxPerHour: number; minResponseMs: number };
  /** PoC用の診断エンドポイント（SSEの長時間接続確認）。既定OFF */
  diagnosticsEnabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function loadApiConfig(env: Env = process.env): ApiConfig {
  const parsed = apiEnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`Invalid API configuration: ${formatZodError(parsed.error)}`);
  const e = parsed.data;

  const auth: ApiConfig['auth'] =
    e.AUTH_BACKEND === 'cognito'
      ? {
          backend: 'cognito',
          userPoolId: required(e.COGNITO_USER_POOL_ID, 'COGNITO_USER_POOL_ID'),
          clientId: required(e.COGNITO_CLIENT_ID, 'COGNITO_CLIENT_ID'),
          clientSecretId: required(e.COGNITO_CLIENT_SECRET_ID, 'COGNITO_CLIENT_SECRET_ID'),
        }
      : { backend: 'dev-auth' };

  const agent: ApiConfig['agent'] =
    e.AGENT_BACKEND === 'agentcore'
      ? {
          backend: 'agentcore',
          runtimeArn: required(e.AGENT_RUNTIME_ARN, 'AGENT_RUNTIME_ARN'),
          qualifier: e.AGENT_RUNTIME_QUALIFIER,
        }
      : { backend: 'local-strands', url: e.LOCAL_AGENT_URL };

  const config: ApiConfig = {
    mode: e.APP_MODE,
    ...(e.APP_ORIGIN ? { appOrigin: stripTrailingSlash(e.APP_ORIGIN) } : {}),
    ...(e.APP_ORIGIN_PARAMETER ? { appOriginParameter: e.APP_ORIGIN_PARAMETER } : {}),
    region: e.AWS_REGION,
    ...(e.AWS_ENDPOINT_URL ? { awsEndpointUrl: e.AWS_ENDPOINT_URL } : {}),
    tables: { data: e.DATA_TABLE_NAME, session: e.SESSION_TABLE_NAME },
    auth,
    agent,
    modelId: e.MODEL_ID,
    webSearchEnabled: e.WEB_SEARCH_ENABLED,
    quota: {
      dailyRequests: e.QUOTA_DAILY_REQUESTS,
      hourlyRequests: e.QUOTA_HOURLY_REQUESTS,
      dailySearches: e.QUOTA_DAILY_SEARCHES,
      timeZone: e.QUOTA_TIMEZONE,
      retentionDays: e.USAGE_RETENTION_DAYS,
    },
    generation: {
      contextTurns: e.CONTEXT_TURNS,
      maxToolCalls: e.MAX_TOOL_CALLS,
      maxOutputTokens: e.MAX_OUTPUT_TOKENS,
      timeoutMs: e.GENERATION_TIMEOUT_MS,
      agentReadTimeoutMs: e.AGENT_READ_TIMEOUT_MS,
      bffMaxDurationMs: e.BFF_MAX_DURATION_MS,
      lockTtlSeconds: e.LOCK_TTL_SECONDS,
      heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    },
    session: {
      absoluteTtlSeconds: e.SESSION_ABSOLUTE_TTL_SECONDS,
      idleTtlSeconds: e.SESSION_IDLE_TTL_SECONDS,
      touchIntervalSeconds: e.SESSION_TOUCH_INTERVAL_SECONDS,
      authFlowTtlSeconds: e.AUTH_FLOW_TTL_SECONDS,
    },
    otp: {
      cooldownSeconds: e.OTP_COOLDOWN_SECONDS,
      maxPerHour: e.OTP_MAX_PER_HOUR,
      minResponseMs: e.AUTH_MIN_RESPONSE_MS,
    },
    diagnosticsEnabled: e.DIAGNOSTICS_ENABLED,
    logLevel: e.LOG_LEVEL,
  };

  assertApiConfigSafety(config, env);
  return config;
}

/**
 * fail-closed検証（§1.5）。
 * - aws: dev-auth / local-strands / エンドポイント上書きは起動不可
 * - local: AWSのマネージド実行基盤上では起動不可。SDKは必ずローカルエミュレーターへ
 * - タイムアウト階層: 生成上限 < BFF最大実行時間 < ロック期限（§9.4）
 */
export function assertApiConfigSafety(config: ApiConfig, env: Env = process.env): void {
  if (config.mode === 'aws') {
    if (config.auth.backend !== 'cognito') throw new ConfigError('APP_MODE=aws requires AUTH_BACKEND=cognito');
    if (config.agent.backend !== 'agentcore') throw new ConfigError('APP_MODE=aws requires AGENT_BACKEND=agentcore');
    if (config.awsEndpointUrl) throw new ConfigError('AWS_ENDPOINT_URL must not be set when APP_MODE=aws');
    if (!config.appOrigin && !config.appOriginParameter)
      throw new ConfigError('APP_MODE=aws requires APP_ORIGIN or APP_ORIGIN_PARAMETER');
    if (config.appOrigin && !config.appOrigin.startsWith('https://'))
      throw new ConfigError('APP_ORIGIN must be https in APP_MODE=aws');
  } else {
    if (isManagedAwsRuntime(env)) throw new ConfigError('APP_MODE=local must not run on AWS managed runtimes');
    if (config.auth.backend !== 'dev-auth') throw new ConfigError('APP_MODE=local requires AUTH_BACKEND=dev-auth');
    if (config.agent.backend !== 'local-strands')
      throw new ConfigError('APP_MODE=local requires AGENT_BACKEND=local-strands');
    if (!config.awsEndpointUrl || !isLoopbackUrl(config.awsEndpointUrl))
      throw new ConfigError('APP_MODE=local requires AWS_ENDPOINT_URL pointing to the local emulator (MiniStack)');
    if (!config.appOrigin) throw new ConfigError('APP_MODE=local requires APP_ORIGIN');
  }
  const g = config.generation;
  if (!(g.timeoutMs < g.bffMaxDurationMs && g.bffMaxDurationMs < g.lockTtlSeconds * 1000)) {
    throw new ConfigError(
      'Timeout hierarchy violated: GENERATION_TIMEOUT_MS < BFF_MAX_DURATION_MS < LOCK_TTL_SECONDS*1000 is required',
    );
  }
  if (g.agentReadTimeoutMs < g.timeoutMs || g.agentReadTimeoutMs >= g.bffMaxDurationMs) {
    throw new ConfigError('AGENT_READ_TIMEOUT_MS must be >= GENERATION_TIMEOUT_MS and < BFF_MAX_DURATION_MS');
  }
}

// ---------------------------------------------------------------------------
// Agent (apps/agent)
// ---------------------------------------------------------------------------

const agentEnvSchema = z.object({
  APP_MODE: z.enum(['local', 'aws']),
  AWS_REGION: z.string().min(1).default('ap-northeast-1'),
  MODEL_PROVIDER: z.enum(['fixed', 'bedrock']),
  MODEL_ID: z.string().min(1).default('jp.anthropic.claude-haiku-5-5'),
  MODEL_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.3),
  SEARCH_BACKEND: z.enum(['fixture', 'agentcore-web-search']),
  WEB_SEARCH_ENABLED: bool(true),
  GATEWAY_URL: z.url().optional(),
  SEARCH_FIXTURES_DIR: z.string().min(1).optional(),
  SEARCH_TIMEOUT_MS: int(10_000, 100),
  SEARCH_MAX_RESULTS: int(5, 1),
  SEARCH_MAX_QUERY_LENGTH: int(200, 1),
  SEARCH_SNIPPET_MAX_CHARS: int(600, 50),
  SEARCH_DENY_DOMAINS: csv,
  INPUT_BUDGET_CHARS: int(24_000, 1000),
  FIXED_MODEL_CHUNK_DELAY_MS: int(15, 0),
  PORT: int(8080, 1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AgentConfig = {
  mode: AppMode;
  region: string;
  model: { provider: ModelProviderKind; modelId: string; temperature: number; fixedChunkDelayMs: number };
  search: {
    backend: SearchBackend;
    enabled: boolean;
    gatewayUrl?: string;
    fixturesDir?: string;
    timeoutMs: number;
    maxResults: number;
    maxQueryLength: number;
    snippetMaxChars: number;
    denyDomains: string[];
  };
  inputBudgetChars: number;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

export function loadAgentConfig(env: Env = process.env): AgentConfig {
  const parsed = agentEnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`Invalid agent configuration: ${formatZodError(parsed.error)}`);
  const e = parsed.data;
  const config: AgentConfig = {
    mode: e.APP_MODE,
    region: e.AWS_REGION,
    model: {
      provider: e.MODEL_PROVIDER,
      modelId: e.MODEL_ID,
      temperature: e.MODEL_TEMPERATURE,
      fixedChunkDelayMs: e.FIXED_MODEL_CHUNK_DELAY_MS,
    },
    search: {
      backend: e.SEARCH_BACKEND,
      enabled: e.WEB_SEARCH_ENABLED,
      ...(e.GATEWAY_URL ? { gatewayUrl: e.GATEWAY_URL } : {}),
      ...(e.SEARCH_FIXTURES_DIR ? { fixturesDir: e.SEARCH_FIXTURES_DIR } : {}),
      timeoutMs: e.SEARCH_TIMEOUT_MS,
      maxResults: e.SEARCH_MAX_RESULTS,
      maxQueryLength: e.SEARCH_MAX_QUERY_LENGTH,
      snippetMaxChars: e.SEARCH_SNIPPET_MAX_CHARS,
      denyDomains: e.SEARCH_DENY_DOMAINS,
    },
    inputBudgetChars: e.INPUT_BUDGET_CHARS,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
  };
  assertAgentConfigSafety(config, env);
  return config;
}

export function assertAgentConfigSafety(config: AgentConfig, env: Env = process.env): void {
  if (config.mode === 'aws') {
    if (config.model.provider !== 'bedrock') throw new ConfigError('APP_MODE=aws requires MODEL_PROVIDER=bedrock');
    if (config.search.backend !== 'agentcore-web-search')
      throw new ConfigError('APP_MODE=aws requires SEARCH_BACKEND=agentcore-web-search');
    if (config.search.enabled && !config.search.gatewayUrl)
      throw new ConfigError('GATEWAY_URL is required when web search is enabled in APP_MODE=aws');
  } else {
    if (isManagedAwsRuntime(env)) throw new ConfigError('APP_MODE=local must not run on AWS managed runtimes');
    if (config.search.backend !== 'fixture') throw new ConfigError('APP_MODE=local requires SEARCH_BACKEND=fixture');
    if (config.model.provider !== 'fixed') throw new ConfigError('APP_MODE=local requires MODEL_PROVIDER=fixed');
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
