import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

/**
 * CloudFront 用 WAF（任意・既定OFF、us-east-1）。最初は Count で誤検知を確認してから Block に変える（§11.4）。
 * `blockMode=true` で Block に切り替える。
 */
export class WafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps & { appName: string; stage: string; blockMode?: boolean }) {
    super(scope, id, props);
    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: props.blockMode ? { none: {} } : { count: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: name },
    });
    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.appName}-${props.stage}-cloudfront`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `${props.appName}-${props.stage}` },
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 0),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 1),
        {
          name: 'AuthRateLimit',
          priority: 2,
          action: props.blockMode ? { block: {} } : { count: {} },
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: '/api/auth/',
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'AuthRateLimit' },
        },
      ],
    });
    this.webAclArn = acl.attrArn;
    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn });
  }
}
