import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Chat, ChatMessage, Citation, MessageStatus } from '@ai-chat/contracts';
import { errors } from '../lib/errors';

/** 会話テーブルのキー設計（§7.2） */
export const keys = {
  chat: (chatId: string) => `CHAT#${chatId}`,
  user: (sub: string) => `USER#${sub}`,
  meta: 'META',
  message: (messageId: string) => `MSG#${messageId}`,
  run: (requestId: string) => `RUN#${requestId}`,
  usageDaily: (day: string) => `USAGE#D#${day}`,
  usageHourly: (hour: string) => `USAGE#H#${hour}`,
  gsi1Sk: (updatedAt: string, chatId: string) => `${updatedAt}#${chatId}`,
};

export type TitleSource = 'default' | 'auto' | 'user';

export type ChatMetaItem = {
  PK: string;
  SK: 'META';
  type: 'chat';
  chatId: string;
  ownerSub: string;
  title: string;
  titleSource: TitleSource;
  createdAt: string;
  updatedAt: string;
  GSI1PK?: string;
  GSI1SK?: string;
  deletedAt?: string;
  activeRunId?: string;
  /** epoch ms */
  lockExpiresAt?: number;
};

export type MessageItem = {
  PK: string;
  SK: string;
  type: 'message';
  messageId: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  createdAt: string;
  requestId?: string;
  modelId?: string;
  usage?: { inputTokens: number; outputTokens: number; searchCalls: number };
  citations?: Citation[];
  searchedAt?: string;
  searchFailed?: boolean;
};

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type RunItem = {
  PK: string;
  SK: string;
  type: 'run';
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
};

export type UsageCounts = {
  daily: { requests: number; searches: number; actualInputTokens: number; actualOutputTokens: number };
  hourly: { requests: number };
};

export type StartRunParams = {
  chatId: string;
  ownerSub: string;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
  content: string;
  /** 自動タイトル（titleSource=defaultの場合のみ設定する） */
  autoTitle?: string;
  now: Date;
  lockExpiresAt: number;
  modelId: string;
  usage: {
    dayKey: string;
    hourKey: string;
    dailyLimit: number;
    hourlyLimit: number;
    /** epoch seconds（TTL） */
    expiresAt: number;
  };
};

export type FinishRunParams = {
  chatId: string;
  ownerSub: string;
  requestId: string;
  assistantMessageId: string;
  status: Exclude<MessageStatus, 'streaming'>;
  content: string;
  citations: Citation[];
  usage: { inputTokens: number; outputTokens: number; searchCalls: number };
  searched: boolean;
  searchFailed: boolean;
  errorCode?: string;
  now: Date;
  dayKey: string;
  usageExpiresAt: number;
};

export type StartRunFailure = 'duplicate' | 'busy_or_gone' | 'quota_daily' | 'quota_hourly' | 'unknown';

export class StartRunConflict extends Error {
  constructor(readonly reasons: StartRunFailure[]) {
    super(`start run conflict: ${reasons.join(',')}`);
    this.name = 'StartRunConflict';
  }
}

const isConditionalFailure = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ConditionalCheckFailedException';

const isTxCanceled = (e: unknown): e is { CancellationReasons?: Array<{ Code?: string }> } =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'TransactionCanceledException';

export function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

/** 改ざん対策として、期待するパーティションキーと一致しないカーソルは拒否する */
export function decodeCursor(cursor: string | undefined, expected: Record<string, string>): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw errors.validation([{ path: 'cursor', message: 'invalid cursor' }]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw errors.validation([{ path: 'cursor', message: 'invalid cursor' }]);
  }
  const record = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    if (record[k] !== v) throw errors.validation([{ path: 'cursor', message: 'invalid cursor' }]);
  }
  for (const v of Object.values(record)) {
    if (typeof v !== 'string') throw errors.validation([{ path: 'cursor', message: 'invalid cursor' }]);
  }
  return record;
}

export function toChat(meta: ChatMetaItem): Chat {
  return { id: meta.chatId, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt };
}

export function toMessage(item: MessageItem): ChatMessage {
  return {
    id: item.messageId,
    chatId: item.chatId,
    role: item.role,
    content: item.content,
    status: item.status,
    ...(item.citations && item.citations.length > 0 ? { citations: item.citations } : {}),
    ...(item.searchFailed ? { searchFailed: true } : {}),
    createdAt: item.createdAt,
  };
}

export class ChatRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async createChat(params: { chatId: string; ownerSub: string; title: string; titleSource: TitleSource; now: Date }) {
    const iso = params.now.toISOString();
    const item: ChatMetaItem = {
      PK: keys.chat(params.chatId),
      SK: 'META',
      type: 'chat',
      chatId: params.chatId,
      ownerSub: params.ownerSub,
      title: params.title,
      titleSource: params.titleSource,
      createdAt: iso,
      updatedAt: iso,
      GSI1PK: keys.user(params.ownerSub),
      GSI1SK: keys.gsi1Sk(iso, params.chatId),
    };
    await this.db.send(
      new PutCommand({ TableName: this.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
    );
    return item;
  }

  async getMeta(chatId: string, consistent = true): Promise<ChatMetaItem | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: keys.chat(chatId), SK: 'META' }, ConsistentRead: consistent }),
    );
    return res.Item as ChatMetaItem | undefined;
  }

  async getRun(chatId: string, requestId: string): Promise<RunItem | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: keys.chat(chatId), SK: keys.run(requestId) }, ConsistentRead: true }),
    );
    return res.Item as RunItem | undefined;
  }

  async listChats(ownerSub: string, limit: number, cursor?: string): Promise<{ items: ChatMetaItem[]; nextCursor: string | null }> {
    const gsi1pk = keys.user(ownerSub);
    const startKey = decodeCursor(cursor, { GSI1PK: gsi1pk });
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': gsi1pk },
        ScanIndexForward: false,
        Limit: limit,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    // GSIは結果整合のため、論理削除直後のレコードや他人のレコードを念のため除外する
    const items = ((res.Items ?? []) as ChatMetaItem[]).filter((m) => !m.deletedAt && m.ownerSub === ownerSub);
    return { items, nextCursor: encodeCursor(res.LastEvaluatedKey) };
  }

  async updateTitle(chatId: string, ownerSub: string, title: string, now: Date): Promise<ChatMetaItem | undefined> {
    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: keys.chat(chatId), SK: 'META' },
          UpdateExpression: 'SET title = :title, titleSource = :user, updatedAt = :now, GSI1SK = :gsi1sk',
          ConditionExpression: 'attribute_exists(PK) AND ownerSub = :sub AND attribute_not_exists(deletedAt)',
          ExpressionAttributeValues: {
            ':title': title,
            ':user': 'user',
            ':now': now.toISOString(),
            ':gsi1sk': keys.gsi1Sk(now.toISOString(), chatId),
            ':sub': ownerSub,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes as ChatMetaItem;
    } catch (e) {
      if (isConditionalFailure(e)) return undefined;
      throw e;
    }
  }

  /** 論理削除。生成中（有効なロックあり）は失敗する。戻り値: 'deleted' | 'busy' | 'not_found' */
  async softDelete(chatId: string, ownerSub: string, now: Date): Promise<'deleted' | 'busy' | 'not_found'> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: keys.chat(chatId), SK: 'META' },
          UpdateExpression: 'SET deletedAt = :now REMOVE GSI1PK, GSI1SK',
          ConditionExpression:
            'attribute_exists(PK) AND ownerSub = :sub AND attribute_not_exists(deletedAt) AND (attribute_not_exists(activeRunId) OR lockExpiresAt < :nowMs)',
          ExpressionAttributeValues: { ':now': now.toISOString(), ':sub': ownerSub, ':nowMs': now.getTime() },
        }),
      );
      return 'deleted';
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
      const meta = await this.getMeta(chatId);
      if (!meta || meta.ownerSub !== ownerSub || meta.deletedAt) return 'not_found';
      return 'busy';
    }
  }

  /** 論理削除済みチャットのメッセージ・RUNをページングで物理削除する（METAは墓標として残す） */
  async purgeChatItems(chatId: string): Promise<number> {
    let deleted = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': keys.chat(chatId) },
          ProjectionExpression: 'PK, SK',
          Limit: 100,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      const targets = (res.Items ?? []).filter((i) => i.SK !== 'META');
      for (let i = 0; i < targets.length; i += 25) {
        let requests = targets.slice(i, i + 25).map((t) => ({ DeleteRequest: { Key: { PK: t.PK, SK: t.SK } } }));
        for (let attempt = 0; requests.length > 0 && attempt < 5; attempt++) {
          const out = await this.db.send(new BatchWriteCommand({ RequestItems: { [this.table]: requests } }));
          const unprocessed = out.UnprocessedItems?.[this.table] ?? [];
          deleted += requests.length - unprocessed.length;
          requests = unprocessed as typeof requests;
          if (requests.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        }
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return deleted;
  }

  /** メッセージ一覧（新しい順に取得し、時系列昇順で返す） */
  async listMessages(chatId: string, limit: number, cursor?: string): Promise<{ items: MessageItem[]; nextCursor: string | null }> {
    const pk = keys.chat(chatId);
    const startKey = decodeCursor(cursor, { PK: pk });
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :msg)',
        ExpressionAttributeValues: { ':pk': pk, ':msg': 'MSG#' },
        ScanIndexForward: false,
        Limit: limit,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    const items = ((res.Items ?? []) as MessageItem[]).reverse();
    return { items, nextCursor: encodeCursor(res.LastEvaluatedKey) };
  }

  /** 直近の完了済みメッセージ（時系列昇順） */
  async recentCompletedMessages(chatId: string, max: number): Promise<MessageItem[]> {
    if (max <= 0) return [];
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :msg)',
        ExpressionAttributeValues: { ':pk': keys.chat(chatId), ':msg': 'MSG#' },
        ScanIndexForward: false,
        Limit: max + 10,
        ConsistentRead: true,
      }),
    );
    return ((res.Items ?? []) as MessageItem[])
      .filter((m) => m.status === 'completed' && m.content.trim().length > 0)
      .slice(0, max)
      .reverse();
  }

  async getUsage(ownerSub: string, day: string, hour: string): Promise<UsageCounts> {
    const [d, h] = await Promise.all([
      this.db.send(new GetCommand({ TableName: this.table, Key: { PK: keys.user(ownerSub), SK: keys.usageDaily(day) } })),
      this.db.send(new GetCommand({ TableName: this.table, Key: { PK: keys.user(ownerSub), SK: keys.usageHourly(hour) } })),
    ]);
    const di = (d.Item ?? {}) as Record<string, number | undefined>;
    const hi = (h.Item ?? {}) as Record<string, number | undefined>;
    return {
      daily: {
        requests: di.requests ?? 0,
        searches: di.searches ?? 0,
        actualInputTokens: di.actualInputTokens ?? 0,
        actualOutputTokens: di.actualOutputTokens ?? 0,
      },
      hourly: { requests: hi.requests ?? 0 },
    };
  }

  /**
   * 生成開始（§7.3）。RUNの条件付き作成（冪等性）、user/assistantメッセージ作成、ロック取得、
   * クォータ加算（消費確定）を1トランザクションで行う。
   */
  async startRun(p: StartRunParams): Promise<void> {
    const iso = p.now.toISOString();
    const pk = keys.chat(p.chatId);
    const userPk = keys.user(p.ownerSub);
    const run: RunItem = {
      PK: pk,
      SK: keys.run(p.requestId),
      type: 'run',
      requestId: p.requestId,
      userMessageId: p.userMessageId,
      assistantMessageId: p.assistantMessageId,
      status: 'running',
      startedAt: iso,
    };
    const userMsg: MessageItem = {
      PK: pk,
      SK: keys.message(p.userMessageId),
      type: 'message',
      messageId: p.userMessageId,
      chatId: p.chatId,
      role: 'user',
      content: p.content,
      status: 'completed',
      createdAt: iso,
      requestId: p.requestId,
    };
    const assistantMsg: MessageItem = {
      PK: pk,
      SK: keys.message(p.assistantMessageId),
      type: 'message',
      messageId: p.assistantMessageId,
      chatId: p.chatId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: iso,
      requestId: p.requestId,
      modelId: p.modelId,
    };
    const metaValues: Record<string, unknown> = {
      ':rid': p.requestId,
      ':lock': p.lockExpiresAt,
      ':now': iso,
      ':nowMs': p.now.getTime(),
      ':gsi1sk': keys.gsi1Sk(iso, p.chatId),
      ':sub': p.ownerSub,
    };
    let metaUpdate = 'SET activeRunId = :rid, lockExpiresAt = :lock, updatedAt = :now, GSI1SK = :gsi1sk';
    const metaCondition =
      'attribute_exists(PK) AND ownerSub = :sub AND attribute_not_exists(deletedAt) AND (attribute_not_exists(activeRunId) OR lockExpiresAt < :nowMs)';
    if (p.autoTitle !== undefined) {
      metaUpdate += ', title = :title, titleSource = :auto';
      Object.assign(metaValues, { ':title': p.autoTitle, ':auto': 'auto' });
    }
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.table, Item: run, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: this.table, Item: userMsg, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: this.table, Item: assistantMsg, ConditionExpression: 'attribute_not_exists(PK)' } },
            {
              Update: {
                TableName: this.table,
                Key: { PK: pk, SK: 'META' },
                UpdateExpression: metaUpdate,
                ConditionExpression: metaCondition,
                ExpressionAttributeValues: metaValues,
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { PK: userPk, SK: keys.usageDaily(p.usage.dayKey) },
                UpdateExpression: 'ADD requests :one SET updatedAt = :now, expiresAt = :exp',
                ConditionExpression: 'attribute_not_exists(requests) OR requests < :limit',
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':now': iso,
                  ':exp': p.usage.expiresAt,
                  ':limit': p.usage.dailyLimit,
                },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { PK: userPk, SK: keys.usageHourly(p.usage.hourKey) },
                UpdateExpression: 'ADD requests :one SET expiresAt = :exp',
                ConditionExpression: 'attribute_not_exists(requests) OR requests < :limit',
                ExpressionAttributeValues: { ':one': 1, ':exp': p.usage.expiresAt, ':limit': p.usage.hourlyLimit },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (!isTxCanceled(e)) throw e;
      const codes = e.CancellationReasons?.map((r) => r.Code) ?? [];
      const reasons: StartRunFailure[] = [];
      if (codes[0] === 'ConditionalCheckFailed') reasons.push('duplicate');
      if (codes[3] === 'ConditionalCheckFailed') reasons.push('busy_or_gone');
      if (codes[4] === 'ConditionalCheckFailed') reasons.push('quota_daily');
      if (codes[5] === 'ConditionalCheckFailed') reasons.push('quota_hourly');
      if (reasons.length === 0) reasons.push('unknown');
      throw new StartRunConflict(reasons);
    }
  }

  /** 生成完了・失敗・中断の確定（本文・usage・出典の保存、RUN終了、ロック解放）とUsage日次行への実績加算 */
  async finishRun(p: FinishRunParams): Promise<boolean> {
    const iso = p.now.toISOString();
    const pk = keys.chat(p.chatId);
    const msgValues: Record<string, unknown> = {
      ':content': p.content,
      ':status': p.status,
      ':usage': p.usage,
      ':streaming': 'streaming',
    };
    let msgUpdate = 'SET content = :content, #status = :status, #usage = :usage';
    if (p.citations.length > 0) {
      msgUpdate += ', citations = :citations';
      msgValues[':citations'] = p.citations;
    }
    if (p.searched) {
      msgUpdate += ', searchedAt = :now';
      msgValues[':now'] = iso;
    }
    if (p.searchFailed) {
      msgUpdate += ', searchFailed = :true';
      msgValues[':true'] = true;
    }
    const runStatus: RunStatus = p.status;
    let committed = true;
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { PK: pk, SK: keys.message(p.assistantMessageId) },
                UpdateExpression: msgUpdate,
                ConditionExpression: '#status = :streaming',
                ExpressionAttributeNames: { '#status': 'status', '#usage': 'usage' },
                ExpressionAttributeValues: msgValues,
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { PK: pk, SK: keys.run(p.requestId) },
                UpdateExpression: p.errorCode
                  ? 'SET #status = :status, finishedAt = :now, errorCode = :err'
                  : 'SET #status = :status, finishedAt = :now',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':status': runStatus,
                  ':now': iso,
                  ...(p.errorCode ? { ':err': p.errorCode } : {}),
                },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { PK: pk, SK: 'META' },
                UpdateExpression: 'REMOVE activeRunId, lockExpiresAt',
                ConditionExpression: 'activeRunId = :rid',
                ExpressionAttributeValues: { ':rid': p.requestId },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (!isTxCanceled(e)) throw e;
      // 遅延回復が先に interrupted 化した等。結果は保存しない（ロックは既に解放済み）
      committed = false;
    }
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: keys.user(p.ownerSub), SK: keys.usageDaily(p.dayKey) },
        UpdateExpression:
          'ADD actualInputTokens :in, actualOutputTokens :out, searches :search SET updatedAt = :now, expiresAt = if_not_exists(expiresAt, :exp)',
        ExpressionAttributeValues: {
          ':in': p.usage.inputTokens,
          ':out': p.usage.outputTokens,
          ':search': p.usage.searchCalls,
          ':now': iso,
          ':exp': p.usageExpiresAt,
        },
      }),
    );
    return committed;
  }

  /**
   * 異常終了時の遅延回復（§7.4）。期限切れロックが残っていれば、assistantメッセージとRUNを
   * interrupted にしてロックを解放する。戻り値は回復後のMETA。
   */
  async recoverStaleRun(meta: ChatMetaItem, now: Date): Promise<ChatMetaItem> {
    if (!meta.activeRunId || meta.lockExpiresAt === undefined || meta.lockExpiresAt >= now.getTime()) return meta;
    const runId = meta.activeRunId;
    const pk = keys.chat(meta.chatId);
    const run = await this.getRun(meta.chatId, runId);
    const iso = now.toISOString();
    const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
      {
        Update: {
          TableName: this.table,
          Key: { PK: pk, SK: 'META' },
          UpdateExpression: 'REMOVE activeRunId, lockExpiresAt',
          ConditionExpression: 'activeRunId = :rid AND lockExpiresAt < :nowMs',
          ExpressionAttributeValues: { ':rid': runId, ':nowMs': now.getTime() },
        },
      },
    ];
    if (run) {
      items.push(
        {
          Update: {
            TableName: this.table,
            Key: { PK: pk, SK: keys.run(runId) },
            UpdateExpression: 'SET #status = :interrupted, finishedAt = :now',
            ConditionExpression: '#status = :running',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':interrupted': 'interrupted', ':running': 'running', ':now': iso },
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: { PK: pk, SK: keys.message(run.assistantMessageId) },
            UpdateExpression: 'SET #status = :interrupted',
            ConditionExpression: '#status = :streaming',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':interrupted': 'interrupted', ':streaming': 'streaming' },
          },
        },
      );
    }
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      if (!isTxCanceled(e)) throw e;
      // 並行して回復・完了した。最新状態を読み直す
    }
    return (await this.getMeta(meta.chatId)) ?? meta;
  }

  /** テスト・管理用: ユーザーのUsage行を含め、パーティション内の全アイテムを列挙する */
  async listUserPartition(ownerSub: string): Promise<Array<{ PK: string; SK: string }>> {
    const out: Array<{ PK: string; SK: string }> = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': keys.user(ownerSub) },
          ProjectionExpression: 'PK, SK',
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      out.push(...((res.Items ?? []) as Array<{ PK: string; SK: string }>));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return out;
  }
}
