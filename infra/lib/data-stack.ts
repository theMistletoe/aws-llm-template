import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

/** DynamoDB（§7.1）。data: 会話・メッセージ・利用量（PITRオン）/ session: セッション・認証フロー・送信レート（PITRオフ） */
export class DataStack extends Stack {
  readonly dataTable: dynamodb.Table;
  readonly sessionTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StackProps & { appName: string; stage: string }) {
    super(scope, id, props);
    this.dataTable = new dynamodb.Table(this, 'DataTable', {
      tableName: `${props.appName}-${props.stage}-data`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.dataTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.sessionTable = new dynamodb.Table(this, 'SessionTable', {
      tableName: `${props.appName}-${props.stage}-session`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
