import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { ChatRepository, StartRunConflict, decodeCursor, encodeCursor, type StartRunParams } from './chat-repository';

function repoWith(send: (cmd: { input: Record<string, unknown>; constructor: { name: string } }) => unknown) {
  const db = { send: vi.fn(async (cmd) => send(cmd)) } as unknown as DynamoDBDocumentClient;
  return { repo: new ChatRepository(db, 'data'), db };
}

const params: StartRunParams = {
  chatId: 'CHAT1',
  ownerSub: 'sub1',
  requestId: 'req1',
  userMessageId: 'U1',
  assistantMessageId: 'A1',
  content: 'hello',
  autoTitle: 'hello',
  now: new Date('2026-10-29T03:00:00Z'),
  lockExpiresAt: Date.parse('2026-10-29T03:03:00Z'),
  modelId: 'm',
  usage: { dayKey: '2026-10-29', hourKey: '2026-10-29T12', dailyLimit: 20, hourlyLimit: 10, expiresAt: 1 },
};

describe('ChatRepository.startRun', () => {
  it('writes run, messages, lock and quota counters in a single conditional transaction', async () => {
    let input: { TransactItems: Array<Record<string, { ConditionExpression?: string; Key?: unknown; Item?: unknown }>> } | undefined;
    const { repo } = repoWith((cmd) => {
      input = cmd.input as typeof input;
      return {};
    });
    await repo.startRun(params);
    const items = input!.TransactItems;
    expect(items).toHaveLength(6);
    expect(items[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items[0]!.Put!.Item).toMatchObject({ PK: 'CHAT#CHAT1', SK: 'RUN#req1', status: 'running' });
    expect(items[2]!.Put!.Item).toMatchObject({ SK: 'MSG#A1', role: 'assistant', status: 'streaming', content: '' });
    expect(items[3]!.Update!.ConditionExpression).toContain('ownerSub = :sub');
    expect(items[3]!.Update!.ConditionExpression).toContain('lockExpiresAt < :nowMs');
    expect(items[4]!.Update!.Key).toEqual({ PK: 'USER#sub1', SK: 'USAGE#D#2026-10-29' });
    expect(items[5]!.Update!.Key).toEqual({ PK: 'USER#sub1', SK: 'USAGE#H#2026-10-29T12' });
    expect(items[4]!.Update!.ConditionExpression).toBe('attribute_not_exists(requests) OR requests < :limit');
  });

  it.each([
    [['ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None'], ['duplicate']],
    [['None', 'None', 'None', 'ConditionalCheckFailed', 'None', 'None'], ['busy_or_gone']],
    [['None', 'None', 'None', 'None', 'ConditionalCheckFailed', 'ConditionalCheckFailed'], ['quota_daily', 'quota_hourly']],
    [[], ['unknown']],
  ])('maps cancellation reasons %j to %j', async (codes, reasons) => {
    const { repo } = repoWith(() => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: codes.map((Code) => ({ Code })),
      });
    });
    const err = await repo.startRun(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartRunConflict);
    expect((err as StartRunConflict).reasons).toEqual(reasons);
  });

  it('propagates unrelated errors', async () => {
    const { repo } = repoWith(() => {
      throw Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' });
    });
    await expect(repo.startRun(params)).rejects.toThrow('x');
  });
});

describe('ChatRepository.finishRun', () => {
  it('releases the lock only for the matching run and still records usage when superseded', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const { repo } = repoWith((cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'TransactWriteCommand') {
        throw Object.assign(new Error('c'), { name: 'TransactionCanceledException' });
      }
      return {};
    });
    const committed = await repo.finishRun({
      chatId: 'CHAT1',
      ownerSub: 'sub1',
      requestId: 'req1',
      assistantMessageId: 'A1',
      status: 'completed',
      content: 'answer',
      citations: [{ title: 't', url: 'https://example.com' }],
      usage: { inputTokens: 1, outputTokens: 2, searchCalls: 1 },
      searched: true,
      searchFailed: false,
      now: new Date('2026-10-29T03:01:00Z'),
      dayKey: '2026-10-29',
      usageExpiresAt: 1,
    });
    expect(committed).toBe(false);
    const tx = calls[0]!.input as { TransactItems: Array<{ Update: { ConditionExpression?: string; UpdateExpression: string } }> };
    expect(tx.TransactItems[0]!.Update.ConditionExpression).toBe('#status = :streaming');
    expect(tx.TransactItems[2]!.Update.ConditionExpression).toBe('activeRunId = :rid');
    expect(tx.TransactItems[2]!.Update.UpdateExpression).toBe('REMOVE activeRunId, lockExpiresAt');
    expect(calls[1]!.name).toBe('UpdateCommand');
    expect(calls[1]!.input).toMatchObject({ Key: { PK: 'USER#sub1', SK: 'USAGE#D#2026-10-29' } });
  });
});

describe('ChatRepository.recoverStaleRun', () => {
  it('does nothing for active locks', async () => {
    const { repo, db } = repoWith(() => ({}));
    const meta = { chatId: 'C', activeRunId: 'r', lockExpiresAt: Date.now() + 10_000 } as never;
    expect(await repo.recoverStaleRun(meta, new Date())).toBe(meta);
    expect(db.send).not.toHaveBeenCalled();
  });

  it('interrupts the message and run and releases the lock with conditions', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const { repo } = repoWith((cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'GetCommand' && (cmd.input.Key as { SK: string }).SK === 'RUN#r') {
        return { Item: { assistantMessageId: 'A1', status: 'running' } };
      }
      if (cmd.constructor.name === 'GetCommand') return { Item: { chatId: 'C' } };
      return {};
    });
    await repo.recoverStaleRun({ chatId: 'C', activeRunId: 'r', lockExpiresAt: 1 } as never, new Date('2026-10-29T00:00:00Z'));
    const tx = calls.find((c) => c.name === 'TransactWriteCommand')!.input as {
      TransactItems: Array<{ Update: { Key: unknown; ConditionExpression: string } }>;
    };
    expect(tx.TransactItems.map((i) => i.Update.ConditionExpression)).toEqual([
      'activeRunId = :rid AND lockExpiresAt < :nowMs',
      '#status = :running',
      '#status = :streaming',
    ]);
    expect(tx.TransactItems[2]!.Update.Key).toEqual({ PK: 'CHAT#C', SK: 'MSG#A1' });
  });
});

describe('cursor', () => {
  it('round-trips and rejects tampering', () => {
    const c = encodeCursor({ PK: 'CHAT#1', SK: 'MSG#2' })!;
    expect(decodeCursor(c, { PK: 'CHAT#1' })).toEqual({ PK: 'CHAT#1', SK: 'MSG#2' });
    expect(() => decodeCursor(c, { PK: 'CHAT#2' })).toThrow();
    expect(() => decodeCursor(Buffer.from('[1]').toString('base64url'), {})).toThrow();
    expect(() => decodeCursor(Buffer.from('{"PK":{"S":"x"}}').toString('base64url'), {})).toThrow();
    expect(decodeCursor(undefined, {})).toBeUndefined();
    expect(encodeCursor(undefined)).toBeNull();
  });
});
