import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AuthFlowType } from '@ai-chat/auth';

/** セッションテーブルのキー（§7.5）。生のセッションID・flowId・メールアドレスはキーにしない */
export const sessionKeys = {
  session: (sessionHash: string) => `SESSION#${sessionHash}`,
  authFlow: (flowHash: string) => `AUTHFLOW#${flowHash}`,
  otpRate: (emailHash: string) => `OTPRATE#${emailHash}`,
};

export type SessionItem = {
  PK: string;
  userSub: string;
  email: string;
  createdAt: string;
  /** epoch seconds */
  lastSeenAt: number;
  /** epoch seconds（絶対有効期限。TTL属性） */
  expiresAt: number;
  revokedAt?: string;
};

export type AuthFlowItem = {
  PK: string;
  flowType: AuthFlowType;
  email: string;
  cognitoSession?: string;
  createdAt: string;
  /** epoch seconds（TTL属性） */
  expiresAt: number;
};

export type OtpRateItem = {
  PK: string;
  /** epoch seconds */
  lastSentAt: number;
  windowStart: number;
  sentCountInHour: number;
  expiresAt: number;
  version: number;
};

const isConditionalFailure = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ConditionalCheckFailedException';

export class SessionRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async putSession(item: Omit<SessionItem, 'PK'> & { sessionHash: string }): Promise<void> {
    const { sessionHash, ...rest } = item;
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: sessionKeys.session(sessionHash), ...rest },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  async getSession(sessionHash: string): Promise<SessionItem | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: sessionKeys.session(sessionHash) }, ConsistentRead: true }),
    );
    return res.Item as SessionItem | undefined;
  }

  async touchSession(sessionHash: string, nowSec: number): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: sessionKeys.session(sessionHash) },
          UpdateExpression: 'SET lastSeenAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(revokedAt)',
          ExpressionAttributeValues: { ':now': nowSec },
        }),
      );
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
    }
  }

  async revokeSession(sessionHash: string, now: Date): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: sessionKeys.session(sessionHash) },
          UpdateExpression: 'SET revokedAt = :now',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':now': now.toISOString() },
        }),
      );
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
    }
  }

  async putAuthFlow(flowHash: string, item: Omit<AuthFlowItem, 'PK'>, mustNotExist = true): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: sessionKeys.authFlow(flowHash), ...item },
        ...(mustNotExist ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
      }),
    );
  }

  /** 認証フローを条件付き削除で一度だけ取り出す（§4.2）。期限切れ・存在しない場合は undefined */
  async consumeAuthFlow(flowHash: string, nowSec: number): Promise<AuthFlowItem | undefined> {
    try {
      const res = await this.db.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { PK: sessionKeys.authFlow(flowHash) },
          ConditionExpression: 'attribute_exists(PK) AND expiresAt > :now',
          ExpressionAttributeValues: { ':now': nowSec },
          ReturnValues: 'ALL_OLD',
        }),
      );
      return res.Attributes as AuthFlowItem | undefined;
    } catch (e) {
      if (isConditionalFailure(e)) return undefined;
      throw e;
    }
  }

  async deleteAuthFlow(flowHash: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { PK: sessionKeys.authFlow(flowHash) } }));
  }

  /**
   * 同一メールへのコード送信レート制限（§8）。60秒に1回、1時間に5回。
   * 送信枠を確保できた場合は ok:true、できない場合は再送可能時刻（epoch seconds）を返す。
   */
  async reserveOtpSend(
    emailHash: string,
    nowSec: number,
    cooldownSeconds: number,
    maxPerHour: number,
  ): Promise<{ ok: true } | { ok: false; retryAt: number }> {
    const key = { PK: sessionKeys.otpRate(emailHash) };
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    const current = res.Item as OtpRateItem | undefined;
    const fresh = current && current.expiresAt > nowSec ? current : undefined;
    if (fresh && nowSec - fresh.lastSentAt < cooldownSeconds) {
      return { ok: false, retryAt: fresh.lastSentAt + cooldownSeconds };
    }
    let windowStart = fresh?.windowStart ?? nowSec;
    let count = fresh?.sentCountInHour ?? 0;
    if (nowSec - windowStart >= 3600) {
      windowStart = nowSec;
      count = 0;
    }
    if (count >= maxPerHour) return { ok: false, retryAt: windowStart + 3600 };
    const next: OtpRateItem = {
      ...key,
      lastSentAt: nowSec,
      windowStart,
      sentCountInHour: count + 1,
      expiresAt: Math.max(windowStart + 3600, nowSec + cooldownSeconds),
      version: (current?.version ?? 0) + 1,
    };
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: next,
          ...(current
            ? { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': current.version } }
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        }),
      );
      return { ok: true };
    } catch (e) {
      if (isConditionalFailure(e)) return { ok: false, retryAt: nowSec + cooldownSeconds };
      throw e;
    }
  }
}
