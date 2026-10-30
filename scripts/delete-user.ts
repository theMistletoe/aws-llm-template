import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_AWS_ENV, ROOT, tableNames } from '../local/lib';

/**
 * 管理者用: ユーザーデータ削除（§13）。既定はドライラン。`--yes` で実行する。
 *   pnpm delete-user -- --email user@example.com [--stage dev] [--yes]
 *   pnpm delete-user -- --email user@example.com --local --yes     # ローカル（MiniStack + dev-auth）
 * 削除対象: Cognitoユーザー、当該ユーザーの会話（META・メッセージ・RUN）。
 * セッション行はユーザー単位の索引を持たないため削除しない（最大8時間で失効。即時停止はREADMEの手順）。
 * PITR には最大35日間データが残る。
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function devSubFor(email: string): string {
  const h = createHash('sha256').update(`dev-auth:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  if (!email) throw new Error('--email を指定してください');
  const local = process.argv.includes('--local');
  const execute = process.argv.includes('--yes');
  const stage = arg('stage') ?? 'dev';
  if (local) Object.assign(process.env, LOCAL_AWS_ENV);
  const region = 'ap-northeast-1';
  const tables = local ? tableNames('local') : { data: `chat-app-${stage}-data`, session: `chat-app-${stage}-session` };
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient(local ? { region, endpoint: LOCAL_AWS_ENV.AWS_ENDPOINT_URL, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : { region }),
  );

  let sub: string;
  let userPoolId: string | undefined;
  const cognito = new CognitoIdentityProviderClient({ region });
  if (local) {
    sub = devSubFor(email);
  } else {
    const outputsFile = resolve(ROOT, 'infra/cdk-outputs.json');
    userPoolId =
      arg('user-pool-id') ??
      (existsSync(outputsFile)
        ? (JSON.parse(readFileSync(outputsFile, 'utf8')) as Record<string, Record<string, string>>)[`ChatApp-${stage}-Auth`]?.UserPoolId
        : undefined);
    if (!userPoolId) throw new Error('--user-pool-id を指定するか infra/cdk-outputs.json を用意してください');
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    const attr = user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (!attr) throw new Error('sub が取得できません');
    sub = attr;
  }

  // 論理削除済みの墓標も含めるため、META を ownerSub で走査する（管理用途の小規模前提）
  const chatIds: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: tables.data,
        FilterExpression: 'SK = :meta AND ownerSub = :sub',
        ExpressionAttributeValues: { ':meta': 'META', ':sub': sub },
        ProjectionExpression: 'chatId',
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    chatIds.push(...(page.Items ?? []).map((i) => String(i.chatId)));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const keys: Array<{ PK: string; SK: string }> = [];
  for (const pk of chatIds.map((id) => `CHAT#${id}`)) {
    let sk: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: tables.data,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ProjectionExpression: 'PK, SK',
          ...(sk ? { ExclusiveStartKey: sk } : {}),
        }),
      );
      keys.push(...((page.Items ?? []) as Array<{ PK: string; SK: string }>));
      sk = page.LastEvaluatedKey;
    } while (sk);
  }

  process.stdout.write(`user: ${email} (sub=${sub})\nchats: ${chatIds.length}, items: ${keys.length}\n`);
  if (!execute) {
    process.stdout.write('ドライランです。削除するには --yes を付けて再実行してください。\n');
    return;
  }
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0 && attempt < 5; attempt++) {
      const res = await db.send(new BatchWriteCommand({ RequestItems: { [tables.data]: requests } }));
      requests = (res.UnprocessedItems?.[tables.data] ?? []) as typeof requests;
    }
  }
  if (!local && userPoolId) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
  process.stdout.write('削除しました。\n');
}

main().catch((e: Error) => {
  process.stderr.write(`${e.name}: ${e.message}\n`);
  process.exit(1);
});
