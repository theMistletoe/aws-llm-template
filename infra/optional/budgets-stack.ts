import { Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';

/** 月次費用通知（任意・既定OFF）。Budgets は支出を停止しないため、BFFの利用上限制御は別途必須（§11.4） */
export class BudgetsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { appName: string; stage: string; monthlyUsd: number; email: string }) {
    super(scope, id, props);
    const subscribers = [{ subscriptionType: 'EMAIL', address: props.email }];
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${props.appName}-${props.stage}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers },
      ],
    });
  }
}
