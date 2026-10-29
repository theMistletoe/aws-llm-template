import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../bin/app';
import { baseModelId } from '../config/app-config';
import { defaultDeployOptions, loadDeploySettings, type DeploySettings } from '../config/options';

function fakeAssets() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-infra-'));
  const api = join(dir, 'api');
  const web = join(dir, 'web');
  mkdirSync(api);
  mkdirSync(web);
  writeFileSync(join(api, 'index.js'), 'export {}');
  writeFileSync(join(web, 'index.html'), '<!doctype html>');
  const agentZipPath = join(dir, 'agent.zip');
  writeFileSync(agentZipPath, 'zip');
  return { apiDistDir: api, agentZipPath, webDistDir: web };
}

const baseSettings: DeploySettings = {
  ...defaultDeployOptions,
  sesFromEmail: 'no-reply@example.com',
  createSesIdentity: false,
  budgetMonthlyUsd: 50,
  modelId: 'jp.anthropic.claude-haiku-5-5',
};

function synth(overrides: Partial<DeploySettings> = {}) {
  const app = buildApp(new App(), fakeAssets(), { ...baseSettings, ...overrides });
  const stack = (name: string) => Template.fromStack(app.node.findChild(`ChatApp-dev-${name}`) as never);
  return { app, stack };
}

describe('default deployment (all optional features OFF)', () => {
  const { app, stack } = synth();

  it('creates only the required stacks', () => {
    expect(app.node.children.map((c) => c.node.id).sort()).toEqual([
      'ChatApp-dev-AgentCore',
      'ChatApp-dev-Api',
      'ChatApp-dev-Auth',
      'ChatApp-dev-Data',
      'ChatApp-dev-Frontend',
      'ChatApp-dev-Monitoring',
    ]);
  });

  it('DataStack: PITR on data only, TTL on expiresAt, GSI1, retained', () => {
    const t = stack('Data');
    t.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        TableName: 'chat-app-dev-data',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'GSI1' })],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'chat-app-dev-session',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: Match.absent(),
    });
  });

  it('AuthStack: Essentials, email OTP, self sign-up, MFA off, no managed login domain', () => {
    const t = stack('Auth');
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'ESSENTIALS',
      MfaConfiguration: 'OFF',
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      UsernameAttributes: ['email'],
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] } }),
      EmailConfiguration: Match.objectLike({ EmailSendingAccount: 'DEVELOPER', From: 'AI Chat <no-reply@example.com>' }),
      DeletionProtection: 'ACTIVE',
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
      AllowedOAuthFlowsUserPoolClient: false,
    });
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
    t.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  it('AgentCoreStack: Node 22 runtime, IAM-authorized gateway and web-search connector, scoped model access', () => {
    const t = stack('AgentCore');
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'chat_app_dev_agent',
      ProtocolConfiguration: 'HTTP',
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300, MaxLifetime: 28800 },
      AgentRuntimeArtifact: { CodeConfiguration: Match.objectLike({ Runtime: 'NODE_22', EntryPoint: ['app.js'] }) },
      EnvironmentVariables: Match.objectLike({ APP_MODE: 'aws', MODEL_PROVIDER: 'bedrock', SEARCH_BACKEND: 'agentcore-web-search' }),
    });
    t.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { AuthorizerType: 'AWS_IAM', ProtocolType: 'MCP' });
    t.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'web-search',
      TargetConfiguration: { Mcp: { Connector: Match.objectLike({ Source: { ConnectorId: 'web-search' } }) } },
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('inference-profile/jp.anthropic.claude-haiku-5-5');
    expect(policies).toContain('foundation-model/anthropic.claude-haiku-5-5');
    expect(policies).not.toMatch(/"bedrock:\*"/);
  });

  it('ApiStack: Web Function behind IAM auth, BFF has no direct model access', () => {
    const t = stack('Api');
    t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', { AuthType: 'IamAuth', EndpointType: 'HomeRegion' });
    t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      BuildConfig: Match.objectLike({ RuntimeConfig: { Runtime: 'nodejs24.x' } }),
      ServiceConfig: Match.objectLike({
        TimeoutSeconds: 150,
        EnvironmentVariables: Match.objectLike({ APP_MODE: 'aws', AUTH_BACKEND: 'cognito', AGENT_BACKEND: 'agentcore' }),
      }),
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('bedrock-agentcore:InvokeAgentRuntime');
    expect(policies).toContain('bedrock-agentcore:StopRuntimeSession');
    expect(policies).not.toContain('bedrock:InvokeModel');
    const env = JSON.stringify(t.findResources('AWS::Lambda::WebFunctionRevision'));
    expect(env).not.toMatch(/dev-auth|local-strands|AWS_ENDPOINT_URL/);
  });

  it('FrontendStack: private S3 + OAC, /api/* uncached without viewer Host, no 403/404→200 rewriting', () => {
    const t = stack('Frontend');
    const dist = t.findResources('AWS::CloudFront::Distribution');
    const config = (Object.values(dist)[0] as { Properties: { DistributionConfig: Record<string, unknown> } }).Properties.DistributionConfig;
    expect(config.CustomErrorResponses).toBeUndefined();
    const api = (config.CacheBehaviors as Array<Record<string, unknown>>).find((b) => b.PathPattern === '/api/*')!;
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad'); // CachingDisabled
    expect(api.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac'); // AllViewerExceptHostHeader
    expect(api.AllowedMethods).toContain('POST');
    expect(api.FunctionAssociations).toBeUndefined();
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always-amz-auth', SigningProtocol: 'sigv4' },
    });
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3' }),
    });
    t.hasResourceProperties('AWS::Lambda::ResourcePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Action: 'lambda:InvokeWebFunctionEndpoint', Principal: { Service: 'cloudfront.amazonaws.com' } })],
      }),
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/chat-app/dev/app-origin' });
  });

  it('MonitoringStack: minimal alarms', () => {
    const t = stack('Monitoring');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    t.resourceCountIs('AWS::SNS::Subscription', 0);
  });
});

describe('optional features', () => {
  it('adds WAF, Budgets, CI/CD and custom domain without changing the core stacks', () => {
    const { app, stack } = synth({
      enableWaf: true,
      enableBudgets: true,
      budgetEmail: 'ops@example.com',
      enableCiCd: true,
      githubRepository: 'owner/repo',
      useCustomDomain: true,
      customDomainName: 'chat.example.com',
      customDomainCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      alarmEmail: 'ops@example.com',
    });
    const ids = app.node.children.map((c) => c.node.id);
    expect(ids).toEqual(expect.arrayContaining(['ChatApp-dev-Waf', 'ChatApp-dev-Budgets', 'ChatApp-dev-Cicd']));
    expect((app.node.findChild('ChatApp-dev-Waf') as unknown as { region: string }).region).toBe('us-east-1');
    stack('Waf').hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
    stack('Frontend').hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['chat.example.com'] }),
    });
    stack('Frontend').resourceCountIs('AWS::SSM::Parameter', 1);
    stack('Api').hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      ServiceConfig: Match.objectLike({ EnvironmentVariables: Match.objectLike({ APP_ORIGIN: 'https://chat.example.com' }) }),
    });
    stack('Monitoring').resourceCountIs('AWS::SNS::Subscription', 1);
  });

  it('switches the BFF to Function URL + response streaming', () => {
    const { stack } = synth({ bffPlatform: 'function-url' });
    stack('Api').hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM', InvokeMode: 'RESPONSE_STREAM' });
    stack('Api').resourceCountIs('AWS::Lambda::WebFunction', 0);
  });

  it('omits the gateway when web search is disabled', () => {
    const { stack } = synth({ webSearchEnabled: false });
    stack('AgentCore').resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
    stack('AgentCore').hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({ WEB_SEARCH_ENABLED: 'false' }),
    });
  });
});

describe('config', () => {
  it('derives base model ids from inference profile ids', () => {
    expect(baseModelId('jp.anthropic.claude-haiku-5-5')).toBe('anthropic.claude-haiku-5-5');
    expect(baseModelId('global.anthropic.claude-sonnet-5-5')).toBe('anthropic.claude-sonnet-5-5');
    expect(baseModelId('anthropic.claude-x')).toBe('anthropic.claude-x');
  });

  it('validates deploy settings', () => {
    const missing = join(tmpdir(), 'does-not-exist.json');
    expect(loadDeploySettings({}, missing)).toMatchObject({ stage: 'dev', enableWaf: false, bffPlatform: 'web-functions' });
    expect(() => loadDeploySettings({ CHAT_APP_STAGE: 'Prod!' }, missing)).toThrow();
    expect(() => loadDeploySettings({ CHAT_APP_USE_CUSTOM_DOMAIN: 'true' }, missing)).toThrow(/customDomainName/);
    expect(() => loadDeploySettings({ CHAT_APP_ENABLE_BUDGETS: 'true' }, missing)).toThrow(/budgetEmail/);
  });
});
