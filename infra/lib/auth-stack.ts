import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';
import type { DeploySettings } from '../config/options';

/**
 * Cognito User Pool（§4.1）: Essentials / セルフサインアップ / メールOTP（パスワードレス）/ MFA OFF。
 * Managed Login と Cognito ドメインは作らない。BFFだけが呼べるよう App Client は Client Secret あり。
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly clientSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: StackProps & { appName: string; settings: DeploySettings }) {
    super(scope, id, props);
    const { settings } = props;
    if (settings.createSesIdentity) {
      new ses.EmailIdentity(this, 'SenderIdentity', { identity: ses.Identity.email(settings.sesFromEmail) });
    }

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.appName}-${settings.stage}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Cognitoの制約で PASSWORD は第1要素から外せない。App Client を USER_AUTH のみにし、
      // パスワードなしでサインアップさせるため、実際にはメールOTPでしかサインインできない（docs/adr参照）
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.NONE,
      email: cognito.UserPoolEmail.withSES({
        fromEmail: settings.sesFromEmail,
        fromName: 'AI Chat',
        sesRegion: this.region,
      }),
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: 'AI Chat 確認コード',
        emailBody: 'AI Chat の確認コードは {####} です。このコードは他の人に教えないでください。',
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const cfnPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnPool.emailAuthenticationSubject = 'AI Chat ログインコード';
    cfnPool.emailAuthenticationMessage = 'AI Chat のログインコードは {####} です。このコードは他の人に教えないでください。';

    this.client = this.userPool.addClient('BffClient', {
      userPoolClientName: `${props.appName}-${settings.stage}-bff`,
      generateSecret: true,
      authFlows: { user: true },
      preventUserExistenceErrors: true,
      disableOAuth: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.minutes(5),
      accessTokenValidity: Duration.minutes(5),
      refreshTokenValidity: Duration.minutes(60),
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true, emailVerified: true }),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
    });

    this.clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      description: 'Cognito App Client secret used by the BFF (SECRET_HASH)',
      secretStringValue: this.client.userPoolClientSecret,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId });
  }
}
