import { Aws, CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * GitHub Actions 用 OIDC ロール（任意・既定OFF）。長期アクセスキーを使わない（§9.6）。
 * CDK bootstrap のデプロイ用ロールを引き受ける権限だけを持つ。
 */
export class CicdStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { appName: string; stage: string; githubRepository: string; existingOidcProviderArn?: string },
  ) {
    super(scope, id, props);
    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });
    const role = new iam.Role(this, 'DeployRole', {
      roleName: `${props.appName}-${props.stage}-github-deploy`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${props.githubRepository}:ref:refs/heads/main`,
            `repo:${props.githubRepository}:environment:${props.stage}`,
          ],
        },
      }),
      description: 'GitHub Actions deploy role (assumes CDK bootstrap roles only)',
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-*`],
      }),
    );
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
