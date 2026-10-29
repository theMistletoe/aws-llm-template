import { Aws, CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import { baseModelId, type AppConfig } from '../config/app-config';
import type { DeploySettings } from '../config/options';

/**
 * AgentCore Runtime（Node.js direct code deploy）+ Gateway（MCP, inbound AWS_IAM）+ Web Search connector（§9.3）。
 */
export class AgentCoreStack extends Stack {
  readonly runtime: agentcore.CfnRuntime;
  readonly runtimeArn: string;
  readonly runtimeId: string;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { appName: string; settings: DeploySettings; config: AppConfig; agentZipPath: string },
  ) {
    super(scope, id, props);
    const { settings, config } = props;
    const namePrefix = `${props.appName}-${settings.stage}`;

    // ZIPはコンテンツハッシュ付きキーで不変に保管される（コード変更でキーが変わり更新される）
    const zip = new s3assets.Asset(this, 'AgentZip', { path: props.agentZipPath });

    let gatewayUrl: string | undefined;
    let gatewayArn: string | undefined;
    if (settings.webSearchEnabled) {
      const gatewayRole = new iam.Role(this, 'GatewayRole', {
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
            ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:gateway/*` },
          },
        }),
        description: 'AgentCore Gateway service role (Web Search connector only)',
      });
      gatewayRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeGateway'],
          resources: [`arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:gateway/*`],
        }),
      );
      gatewayRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeWebSearch'],
          resources: [`arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:*:tool/web-search.v1`],
        }),
      );
      const gateway = new agentcore.CfnGateway(this, 'Gateway', {
        name: `${namePrefix}-gateway`,
        roleArn: gatewayRole.roleArn,
        protocolType: 'MCP',
        authorizerType: 'AWS_IAM',
        protocolConfiguration: { mcp: { supportedVersions: ['2025-11-25', '2025-06-18', '2025-03-26'] } },
        description: 'Web Search only gateway for the chat agent',
      });
      gateway.node.addDependency(gatewayRole);
      // connector の版は CloudFormation では指定できない（既定版を使用。docs/adr/0003 参照）
      const target = new agentcore.CfnGatewayTarget(this, 'WebSearchTarget', {
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        name: 'web-search',
        description: 'AgentCore Web Search connector',
        targetConfiguration: {
          mcp: {
            connector: {
              source: { connectorId: 'web-search' },
              configurations: [{ name: 'WebSearch', parameterValues: {} }],
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      });
      target.node.addDependency(gatewayRole);
      gatewayUrl = gateway.attrGatewayUrl;
      gatewayArn = gateway.attrGatewayArn;
    }

    const runtimeRole = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
        },
      }),
      description: 'AgentCore Runtime execution role (selected model + gateway only)',
    });
    zip.grantRead(runtimeRole);
    const logGroupArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`;
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'], resources: [logGroupArn] }),
    );
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'] }));
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${logGroupArn}:log-stream:*`] }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );
    // 選定した推論プロファイルと、転送先リージョンの基盤モデルだけを許可する（§6.1, §6.7）
    const base = baseModelId(config.modelId);
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeSelectedModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${config.modelId}`,
          `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${base}`,
          `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${base}:*`,
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetInferenceProfile',
        actions: ['bedrock:GetInferenceProfile'],
        resources: [`arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${config.modelId}`],
      }),
    );
    if (gatewayArn) {
      runtimeRole.addToPolicy(
        new iam.PolicyStatement({ sid: 'CallGatewayMcp', actions: ['bedrock-agentcore:InvokeGateway'], resources: [gatewayArn] }),
      );
    }

    const environmentVariables: Record<string, string> = {
      APP_MODE: 'aws',
      MODEL_PROVIDER: 'bedrock',
      MODEL_ID: config.modelId,
      SEARCH_BACKEND: 'agentcore-web-search',
      WEB_SEARCH_ENABLED: String(settings.webSearchEnabled),
      SEARCH_MAX_RESULTS: String(config.search.maxResults),
      SEARCH_MAX_QUERY_LENGTH: String(config.search.maxQueryLength),
      SEARCH_TIMEOUT_MS: String(config.search.timeoutMs),
      SEARCH_SNIPPET_MAX_CHARS: String(config.search.snippetMaxChars),
      SEARCH_DENY_DOMAINS: config.search.denyDomains.join(','),
      LOG_LEVEL: 'info',
      ...(gatewayUrl ? { GATEWAY_URL: gatewayUrl } : {}),
    };

    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: `${props.appName}_${settings.stage}_agent`.replace(/-/g, '_'),
      description: 'Strands Agents (TypeScript) chat agent',
      roleArn: runtimeRole.roleArn,
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: zip.s3BucketName, prefix: zip.s3ObjectKey } },
          runtime: 'NODE_22',
          entryPoint: ['app.js'],
        },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: config.agentCore.idleRuntimeSessionTimeoutSeconds,
        maxLifetime: config.agentCore.maxLifetimeSeconds,
      },
      environmentVariables,
    });
    this.runtime.node.addDependency(runtimeRole);
    this.runtimeArn = this.runtime.attrAgentRuntimeArn;
    this.runtimeId = this.runtime.attrAgentRuntimeId;

    new CfnOutput(this, 'AgentRuntimeArn', { value: this.runtimeArn });
    if (gatewayUrl) new CfnOutput(this, 'GatewayUrl', { value: gatewayUrl });
  }
}
