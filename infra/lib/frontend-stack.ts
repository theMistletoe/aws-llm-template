import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { DeploySettings } from '../config/options';
import type { ApiStack } from './api-stack';
import { functionSource } from './spa-rewrite';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 非公開S3 + CloudFront + OAC（§9.4）。`/api/*` だけBFFへ転送し、APIはキャッシュ無効・viewer Host除外。
 */
export class FrontendStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      appName: string;
      settings: DeploySettings;
      api: ApiStack;
      webDistDir: string;
      appOriginParameterName: string;
      webAclArn?: string;
    },
  ) {
    super(scope, id, props);
    const { settings, api } = props;

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      code: cloudfront.FunctionCode.fromInline(functionSource()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'SPA rewrite generated from infra/lib/spa-rewrite.ts',
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
    });

    let apiOrigin: cloudfront.IOrigin;
    // SSEのハートビート（15秒）より長い無通信タイムアウト
    const timeouts = { readTimeout: Duration.seconds(60), keepaliveTimeout: Duration.seconds(60) };
    if (api.origin.kind === 'web-functions') {
      const oac = new cloudfront.CfnOriginAccessControl(this, 'BffOac', {
        originAccessControlConfig: {
          name: `${props.appName}-${settings.stage}-bff-oac`,
          originAccessControlOriginType: 'lambda',
          signingBehavior: 'always-amz-auth',
          signingProtocol: 'sigv4',
        },
      });
      apiOrigin = new origins.HttpOrigin(api.origin.endpointDomain, {
        originAccessControlId: oac.attrId,
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        ...timeouts,
      });
    } else {
      apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(api.origin.functionUrl, timeouts);
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.appName} ${settings.stage}`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          compress: false,
        },
      },
      ...(settings.useCustomDomain
        ? {
            domainNames: [settings.customDomainName!],
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', settings.customDomainCertificateArn!),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      ...(props.webAclArn ? { webAclId: props.webAclArn } : {}),
    });

    if (api.origin.kind === 'web-functions') {
      // Web Function は AddPermission 非対応のため ResourcePolicy で CloudFront（このDistribution）だけに許可する
      new lambda.CfnResourcePolicy(this, 'BffResourcePolicy', {
        resourceArn: api.origin.functionArn,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowCloudFrontOAC',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 'lambda:InvokeWebFunctionEndpoint',
              Resource: api.origin.endpointArn,
              Condition: { StringEquals: { 'aws:SourceArn': this.distribution.distributionArn } },
            },
          ],
        },
      });
    }

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(props.webDistDir)],
      destinationBucket: siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });

    const appOrigin = settings.useCustomDomain
      ? `https://${settings.customDomainName}`
      : `https://${this.distribution.distributionDomainName}`;
    // BFF は起動時にこの値を読み、Origin を完全一致で検証する（スタック間の循環参照を避けるためSSM経由）
    new ssm.StringParameter(this, 'AppOriginParameter', {
      parameterName: props.appOriginParameterName,
      stringValue: appOrigin,
      description: 'APP_ORIGIN for the BFF Origin check',
    });

    new CfnOutput(this, 'AppUrl', { value: appOrigin });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
