import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { AppConfig } from '../config/app-config';
import type { DeploySettings } from '../config/options';
import type { AgentCoreStack } from './agentcore-stack';
import type { ApiStack } from './api-stack';
import type { DataStack } from './data-stack';

/**
 * 構造化ログ＋最低限のアラーム（§13）。BFFの5xx、AgentCore（Runtime/Gateway）起因のエラー、DynamoDB throttling。
 * 通知先は SNS → メール（alarmEmail 設定時）。
 */
export class MonitoringStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { appName: string; settings: DeploySettings; config: AppConfig; api: ApiStack; data: DataStack; agent: AgentCoreStack },
  ) {
    super(scope, id, props);
    const namespace = `${props.appName}/${props.settings.stage}`;
    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: `${props.appName} ${props.settings.stage} alarms` });
    if (props.settings.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.settings.alarmEmail));
    const notify = new actions.SnsAction(topic);

    const metricFrom = (name: string, pattern: logs.IFilterPattern) => {
      new logs.MetricFilter(this, `${name}Filter`, {
        logGroup: props.api.logGroup,
        metricNamespace: namespace,
        metricName: name,
        filterPattern: pattern,
        metricValue: '1',
        defaultValue: 0,
      });
      return new cloudwatch.Metric({ namespace, metricName: name, statistic: 'Sum', period: Duration.minutes(5) });
    };

    const bff5xx = metricFrom(
      'Bff5xx',
      logs.FilterPattern.all(logs.FilterPattern.stringValue('$.event', '=', 'http_request'), logs.FilterPattern.numberValue('$.status', '>=', 500)),
    );
    new cloudwatch.Alarm(this, 'Bff5xxAlarm', {
      alarmDescription: 'BFF returned 5xx responses',
      metric: bff5xx,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);

    const agentErrors = metricFrom(
      'AgentErrors',
      logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.event', '=', 'generation_finished'),
        logs.FilterPattern.stringValue('$.status', '=', 'failed'),
      ),
    );
    new cloudwatch.Alarm(this, 'AgentErrorsAlarm', {
      alarmDescription: 'AgentCore Runtime / Gateway / model errors observed by the BFF',
      metric: agentErrors,
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);

    const tables: Array<[string, dynamodb.Table]> = [
      ['Data', props.data.dataTable],
      ['Session', props.data.sessionTable],
    ];
    for (const [name, table] of tables) {
      new cloudwatch.Alarm(this, `${name}TableThrottleAlarm`, {
        alarmDescription: `DynamoDB throttling on ${name} table`,
        metric: table.metricThrottledRequestsForOperations({
          operations: [
            dynamodb.Operation.GET_ITEM,
            dynamodb.Operation.PUT_ITEM,
            dynamodb.Operation.UPDATE_ITEM,
            dynamodb.Operation.DELETE_ITEM,
            dynamodb.Operation.QUERY,
            dynamodb.Operation.TRANSACT_WRITE_ITEMS,
          ],
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    }

    // AgentCore Runtime のログ保持期間（ロググループはサービスが作成する）
    new logs.LogRetention(this, 'AgentLogRetention', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${props.agent.runtimeId}-DEFAULT`,
      retention: props.config.logRetentionDays as logs.RetentionDays,
    });
  }
}
