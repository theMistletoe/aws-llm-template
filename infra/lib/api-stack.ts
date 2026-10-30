import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import type { AppConfig } from '../config/app-config';
import type { DeploySettings } from '../config/options';
import type { AgentCoreStack } from './agentcore-stack';
import type { AuthStack } from './auth-stack';
import type { DataStack } from './data-stack';

export type BffOrigin =
  | { kind: 'web-functions'; functionArn: string; endpointArn: string; endpointDomain: string }
  | { kind: 'function-url'; functionUrl: lambda.FunctionUrl };

/**
 * BFF（Hono）。既定は Lambda Web Functions、PoC不合格時は Function URL + Response Streaming（§9.4）。
 * Hono本体は共通で、差分はこのスタックと apps/api/src/server.ts に閉じ込める。
 */
export class ApiStack extends Stack {
  readonly origin: BffOrigin;
  readonly logGroup: logs.LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      appName: string;
      settings: DeploySettings;
      config: AppConfig;
      data: DataStack;
      auth: AuthStack;
      agent: AgentCoreStack;
      apiDistDir: string;
      appOriginParameterName: string;
    },
  ) {
    super(scope, id, props);
    const { settings, config } = props;
    const functionName = `${props.appName}-${settings.stage}-bff`;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/${props.appName}/${settings.stage}/bff`,
      retention: config.logRetentionDays as logs.RetentionDays,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const role = new iam.Role(this, 'BffRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'BFF execution role (DynamoDB, Cognito secret, AgentCore invoke only. No Bedrock model access)',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    props.data.dataTable.grantReadWriteData(role);
    props.data.sessionTable.grantReadWriteData(role);
    props.auth.clientSecret.grantRead(role);
    this.logGroup.grantWrite(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${props.appOriginParameterName}`],
      }),
    );
    // 指定Runtime（とそのエンドポイント）への Invoke / StopRuntimeSession のみ（§6.7）
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'],
        resources: [props.agent.runtimeArn, `${props.agent.runtimeArn}/*`],
      }),
    );

    const g = config.generation;
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      APP_MODE: 'aws',
      ...(settings.useCustomDomain
        ? { APP_ORIGIN: `https://${settings.customDomainName}` }
        : { APP_ORIGIN_PARAMETER: props.appOriginParameterName }),
      DATA_TABLE_NAME: props.data.dataTable.tableName,
      SESSION_TABLE_NAME: props.data.sessionTable.tableName,
      AUTH_BACKEND: 'cognito',
      COGNITO_USER_POOL_ID: props.auth.userPool.userPoolId,
      COGNITO_CLIENT_ID: props.auth.client.userPoolClientId,
      COGNITO_CLIENT_SECRET_ID: props.auth.clientSecret.secretArn,
      AGENT_BACKEND: 'agentcore',
      AGENT_RUNTIME_ARN: props.agent.runtimeArn,
      MODEL_ID: config.modelId,
      WEB_SEARCH_ENABLED: String(settings.webSearchEnabled),
      CONTEXT_TURNS: String(g.contextTurns),
      MAX_TOOL_CALLS: String(g.maxToolCalls),
      MAX_OUTPUT_TOKENS: String(g.maxOutputTokens),
      GENERATION_TIMEOUT_MS: String(g.timeoutMs),
      AGENT_READ_TIMEOUT_MS: String(g.agentReadTimeoutMs),
      BFF_MAX_DURATION_MS: String(g.bffMaxDurationSeconds * 1000),
      LOCK_TTL_SECONDS: String(g.lockTtlSeconds),
      HEARTBEAT_INTERVAL_MS: String(g.heartbeatIntervalMs),
      SESSION_ABSOLUTE_TTL_SECONDS: String(config.session.absoluteTtlSeconds),
      SESSION_IDLE_TTL_SECONDS: String(config.session.idleTtlSeconds),
      OTP_COOLDOWN_SECONDS: String(config.otp.cooldownSeconds),
      OTP_MAX_PER_HOUR: String(config.otp.maxPerHour),
      AUTH_MIN_RESPONSE_MS: String(config.otp.minResponseMs),
      LOG_LEVEL: 'info',
      ...(settings.enableDiagnostics ? { DIAGNOSTICS_ENABLED: 'true' } : {}),
    };

    if (settings.bffPlatform === 'web-functions') {
      const codeBucket = new s3.Bucket(this, 'CodeBucket', {
        versioned: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      codeBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
          actions: ['s3:GetObject', 's3:GetObjectVersion'],
          resources: [codeBucket.arnForObjects('*')],
          conditions: {
            ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:web-function/${functionName}/revision/*` },
          },
        }),
      );
      // 旧Revisionが参照するZIPを消さない（prune: false）。ロールバックに使う（§11.4）
      // objectKeys はプレフィックスを含まないため、バケット直下に置く
      const code = new s3deploy.BucketDeployment(this, 'CodeUpload', {
        sources: [s3deploy.Source.asset(props.apiDistDir)],
        destinationBucket: codeBucket,
        extract: false,
        prune: false,
        retainOnDelete: true,
      });
      const webFn = new lambda.CfnWebFunction(this, 'WebFunction', { functionName });
      const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
        functionName: webFn.ref,
        description: 'Hono BFF',
        buildConfig: {
          codeConfig: {
            s3Object: {
              bucket: codeBucket.bucketName,
              key: Fn.select(0, code.objectKeys),
              versionId: Fn.select(0, code.objectVersionIds),
            },
          },
          runtimeConfig: { runtime: 'nodejs24.x' },
        },
        serviceConfig: {
          executionRoleArn: role.roleArn,
          environmentVariables: environment,
          timeoutSeconds: g.bffMaxDurationSeconds,
          maxConcurrencyPerEnvironment: 64,
          telemetryConfig: { loggingConfig: { logGroup: this.logGroup.logGroupName } },
        },
      });
      revision.node.addDependency(codeBucket.policy!, role, code);
      // コード変更でRevisionは置き換わる。旧Revisionを残し、Endpointの重みを戻すだけで切り戻せるようにする（§11.4）
      revision.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
        functionName: webFn.ref,
        endpointName: settings.stage,
        endpointType: 'HomeRegion',
        // CloudFront OAC からのみ到達可能にする（ApplicationManaged だと公開される）
        authType: 'IamAuth',
        revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
        scalingConfig: { maxEnvironments: 10 },
      });
      Validations.of(this).acknowledge({
        id: 'CloudFormation-Validate::F3006',
        reason: 'AWS::Lambda::WebFunction* types are newer than the bundled validation schema',
      });
      this.origin = {
        kind: 'web-functions',
        functionArn: webFn.attrFunctionArn,
        endpointArn: endpoint.attrEndpointArn,
        endpointDomain: endpoint.attrDomainName,
      };
      new CfnOutput(this, 'WebFunctionEndpointDomain', { value: endpoint.attrDomainName });
    } else {
      const fn = new lambda.Function(this, 'BffFunction', {
        functionName,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(props.apiDistDir),
        memorySize: 1024,
        timeout: Duration.seconds(g.bffMaxDurationSeconds),
        role,
        environment,
        logGroup: this.logGroup,
      });
      const functionUrl = fn.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.AWS_IAM,
        invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      });
      this.origin = { kind: 'function-url', functionUrl };
    }
  }
}
