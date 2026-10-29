import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** MiniStack等のローカルエミュレーター用のダミー認証情報。AWS実キー・SSOへフォールバックさせない */
export const LOCAL_DUMMY_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' } as const;

export type AwsTarget = { mode: 'local'; region: string; endpoint: string } | { mode: 'aws'; region: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'ministack', 'host.docker.internal']);

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/**
 * SDKクライアント共通設定。localでは必ずローカルのendpointとダミー認証情報を使い、
 * IMDSへの問い合わせも無効化してAWSへ送信しない（§11.2）。
 */
export function awsClientConfig(target: AwsTarget) {
  if (target.mode === 'local') {
    if (!isLocalEndpoint(target.endpoint)) {
      throw new Error(`Refusing non-local AWS endpoint in local mode: ${target.endpoint}`);
    }
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    return {
      region: target.region,
      endpoint: target.endpoint,
      credentials: { ...LOCAL_DUMMY_CREDENTIALS },
    };
  }
  return { region: target.region };
}

export function createDynamoDocumentClient(target: AwsTarget): DynamoDBDocumentClient {
  const client = new DynamoDBClient(awsClientConfig(target));
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
