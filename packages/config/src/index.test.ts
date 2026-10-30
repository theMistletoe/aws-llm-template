import { describe, expect, it } from 'vitest';
import { ConfigError, loadAgentConfig, loadApiConfig } from './index';

const localApiEnv = {
  APP_MODE: 'local',
  APP_ORIGIN: 'http://localhost:5173',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  DATA_TABLE_NAME: 'data',
  SESSION_TABLE_NAME: 'session',
  AUTH_BACKEND: 'dev-auth',
  AGENT_BACKEND: 'local-strands',
};

const awsApiEnv = {
  APP_MODE: 'aws',
  APP_ORIGIN: 'https://d111111abcdef8.cloudfront.net',
  DATA_TABLE_NAME: 'data',
  SESSION_TABLE_NAME: 'session',
  AUTH_BACKEND: 'cognito',
  COGNITO_USER_POOL_ID: 'ap-northeast-1_abc',
  COGNITO_CLIENT_ID: 'client',
  COGNITO_CLIENT_SECRET_ID: 'secret-arn',
  AGENT_BACKEND: 'agentcore',
  AGENT_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/x',
};

describe('loadApiConfig', () => {
  it('loads local config with spec defaults', () => {
    const c = loadApiConfig(localApiEnv);
    expect(c.mode).toBe('local');
    expect(c.generation).toMatchObject({
      timeoutMs: 120_000,
      bffMaxDurationMs: 150_000,
      lockTtlSeconds: 180,
      agentReadTimeoutMs: 130_000,
      heartbeatIntervalMs: 15_000,
      maxToolCalls: 3,
      maxOutputTokens: 2048,
      contextTurns: 10,
    });
    expect(c.session).toMatchObject({ absoluteTtlSeconds: 28_800, idleTtlSeconds: 1800, authFlowTtlSeconds: 300 });
    expect(c.otp).toMatchObject({ cooldownSeconds: 60, maxPerHour: 5 });
  });

  it('loads aws config', () => {
    const c = loadApiConfig(awsApiEnv);
    expect(c.auth.backend).toBe('cognito');
    expect(c.agent).toMatchObject({ backend: 'agentcore', qualifier: 'DEFAULT' });
  });

  it.each([
    ['dev-auth in aws', { ...awsApiEnv, AUTH_BACKEND: 'dev-auth' }],
    ['local agent in aws', { ...awsApiEnv, AGENT_BACKEND: 'local-strands' }],
    ['endpoint override in aws', { ...awsApiEnv, AWS_ENDPOINT_URL: 'http://localhost:4566' }],
    ['http origin in aws', { ...awsApiEnv, APP_ORIGIN: 'http://example.com' }],
    ['cognito in local', { ...localApiEnv, AUTH_BACKEND: 'cognito', COGNITO_USER_POOL_ID: 'a', COGNITO_CLIENT_ID: 'b', COGNITO_CLIENT_SECRET_ID: 'c' }],
    ['local on lambda', { ...localApiEnv, AWS_LAMBDA_FUNCTION_NAME: 'fn' }],
    ['local without emulator endpoint', { ...localApiEnv, AWS_ENDPOINT_URL: undefined }],
    ['local with remote endpoint', { ...localApiEnv, AWS_ENDPOINT_URL: 'https://dynamodb.ap-northeast-1.amazonaws.com' }],
    ['lock shorter than generation', { ...localApiEnv, LOCK_TTL_SECONDS: '100' }],
    ['agent read timeout too short', { ...localApiEnv, AGENT_READ_TIMEOUT_MS: '1000' }],
  ])('fails closed: %s', (_name, env) => {
    expect(() => loadApiConfig(env)).toThrow(ConfigError);
  });

  it('rejects invalid values', () => {
    expect(() => loadApiConfig({ ...localApiEnv, MAX_OUTPUT_TOKENS: 'abc' })).toThrow(/MAX_OUTPUT_TOKENS/);
    expect(() => loadApiConfig({ ...localApiEnv, APP_MODE: 'prod' })).toThrow(ConfigError);
  });
});

describe('loadAgentConfig', () => {
  const localAgentEnv = { APP_MODE: 'local', MODEL_PROVIDER: 'fixed', SEARCH_BACKEND: 'fixture' };
  const awsAgentEnv = {
    APP_MODE: 'aws',
    MODEL_PROVIDER: 'bedrock',
    SEARCH_BACKEND: 'agentcore-web-search',
    GATEWAY_URL: 'https://gw.example.com/mcp',
  };

  it('loads both modes', () => {
    expect(loadAgentConfig(localAgentEnv).search.maxQueryLength).toBe(200);
    const aws = loadAgentConfig({ ...awsAgentEnv, SEARCH_DENY_DOMAINS: 'Example.com, evil.test' });
    expect(aws.model.modelId).toBe('jp.anthropic.claude-haiku-5-5');
    expect(aws.search.denyDomains).toEqual(['example.com', 'evil.test']);
  });

  it.each([
    ['fixed model in aws', { ...awsAgentEnv, MODEL_PROVIDER: 'fixed' }],
    ['fixture search in aws', { ...awsAgentEnv, SEARCH_BACKEND: 'fixture' }],
    ['missing gateway in aws', { ...awsAgentEnv, GATEWAY_URL: undefined }],
    ['bedrock in local', { ...localAgentEnv, MODEL_PROVIDER: 'bedrock' }],
    ['local on agentcore', { ...localAgentEnv, AGENTCORE_RUNTIME: '1' }],
  ])('fails closed: %s', (_name, env) => {
    expect(() => loadAgentConfig(env)).toThrow(ConfigError);
  });

  it('allows disabling web search without gateway', () => {
    expect(loadAgentConfig({ ...awsAgentEnv, GATEWAY_URL: undefined, WEB_SEARCH_ENABLED: 'false' }).search.enabled).toBe(false);
  });
});
