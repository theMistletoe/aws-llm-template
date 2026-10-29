import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { MessageList } from '@ai-chat/contracts';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { TABLES } from './env';
import { Client, db, readSse } from './helpers';

/** BFFが生成中に異常終了した状態をDynamoDBに直接作る */
async function crashedRun(ownerSub: string, chatId: string, lockExpiresAt: number) {
  const runId = '01890a5d-ac96-774b-bcce-b302099a8057';
  const userMsg = ulid();
  const assistantMsg = ulid();
  const pk = `CHAT#${chatId}`;
  const now = new Date().toISOString();
  await db.send(new PutCommand({ TableName: TABLES.data, Item: { PK: pk, SK: `RUN#${runId}`, type: 'run', requestId: runId, userMessageId: userMsg, assistantMessageId: assistantMsg, status: 'running', startedAt: now } }));
  await db.send(new PutCommand({ TableName: TABLES.data, Item: { PK: pk, SK: `MSG#${userMsg}`, type: 'message', messageId: userMsg, chatId, role: 'user', content: 'クラッシュ前の質問', status: 'completed', createdAt: now } }));
  await db.send(new PutCommand({ TableName: TABLES.data, Item: { PK: pk, SK: `MSG#${assistantMsg}`, type: 'message', messageId: assistantMsg, chatId, role: 'assistant', content: '', status: 'streaming', createdAt: now } }));
  const meta = await db.send(new GetCommand({ TableName: TABLES.data, Key: { PK: pk, SK: 'META' } }));
  await db.send(new PutCommand({ TableName: TABLES.data, Item: { ...meta.Item, ownerSub, activeRunId: runId, lockExpiresAt } }));
  return { runId, assistantMsg, pk };
}

describe('lazy recovery of abnormally terminated generations (§7.4)', () => {
  it('interrupts expired runs on GET /messages and releases the lock', async () => {
    const c = new Client();
    await c.login();
    const me = (await (await c.get('/api/auth/me')).json()) as { sub: string };
    const chat = await c.createChat();
    const { runId, assistantMsg, pk } = await crashedRun(me.sub, chat.id, Date.now() - 1000);
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.find((m) => m.id === assistantMsg)!.status).toBe('interrupted');
    const meta = await db.send(new GetCommand({ TableName: TABLES.data, Key: { PK: pk, SK: 'META' } }));
    expect(meta.Item!.activeRunId).toBeUndefined();
    const run = await db.send(new GetCommand({ TableName: TABLES.data, Key: { PK: pk, SK: `RUN#${runId}` } }));
    expect(run.Item!.status).toBe('interrupted');
  });

  it('keeps a lock that has not expired (409) and recovers on POST /stream after expiry', async () => {
    const c = new Client();
    await c.login();
    const me = (await (await c.get('/api/auth/me')).json()) as { sub: string };
    const chat = await c.createChat();
    const { assistantMsg, pk } = await crashedRun(me.sub, chat.id, Date.now() + 60_000);
    expect((await c.stream(chat.id, '送れない')).status).toBe(409);
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.find((m) => m.id === assistantMsg)!.status).toBe('streaming');
    // ロック期限を過去にしてから送信すると、遅延回復してから生成する
    const meta = await db.send(new GetCommand({ TableName: TABLES.data, Key: { PK: pk, SK: 'META' } }));
    await db.send(new PutCommand({ TableName: TABLES.data, Item: { ...meta.Item, lockExpiresAt: Date.now() - 1 } }));
    const { events } = await readSse(await c.stream(chat.id, '回復後の質問'));
    expect(events.at(-1)!.event).toBe('done');
    const after = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(after.items.find((m) => m.id === assistantMsg)!.status).toBe('interrupted');
  });
});
