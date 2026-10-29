import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Chat, ChatList, MessageList } from '@ai-chat/contracts';
import { describe, expect, it } from 'vitest';
import { TABLES } from './env';
import { Client, db, readSse } from './helpers';

describe('chat API over HTTP', () => {
  it('CRUD with DynamoDB side effects', async () => {
    const c = new Client();
    await c.login();
    const created = await c.post('/api/v1/chats', { title: '計画' });
    expect(created.status).toBe(201);
    const chat = (await created.json()) as Chat;
    expect(((await (await c.get(`/api/v1/chats/${chat.id}`)).json()) as Chat).title).toBe('計画');
    const renamed = (await (await c.patch(`/api/v1/chats/${chat.id}`, { title: '新しい計画' })).json()) as Chat;
    expect(renamed.title).toBe('新しい計画');
    await readSse(await c.stream(chat.id, 'こんにちは'));
    const before = await db.send(
      new QueryCommand({ TableName: TABLES.data, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CHAT#${chat.id}` } }),
    );
    expect(before.Items!.map((i) => String(i.SK).split('#')[0]).sort()).toEqual(['META', 'MSG', 'MSG', 'RUN']);
    expect((await c.del(`/api/v1/chats/${chat.id}`)).status).toBe(204);
    const after = await db.send(
      new QueryCommand({ TableName: TABLES.data, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CHAT#${chat.id}` } }),
    );
    expect(after.Items).toHaveLength(1);
    expect(after.Items![0]).toMatchObject({ SK: 'META', deletedAt: expect.any(String) });
    expect(after.Items![0]!.GSI1PK).toBeUndefined();
    expect((await c.get(`/api/v1/chats/${chat.id}`)).status).toBe(404);
  });

  it('paginates the chat list via GSI1 with a cursor', async () => {
    const c = new Client();
    await c.login();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await c.createChat()).id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (await c.get(`/api/v1/chats?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json()) as ChatList;
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
  });

  it('isolates users: other users get 404 everywhere and cannot page with forged cursors', async () => {
    const owner = new Client();
    await owner.login();
    const chat = await owner.createChat();
    const other = new Client();
    await other.login();
    expect((await other.get(`/api/v1/chats/${chat.id}`)).status).toBe(404);
    expect((await other.get(`/api/v1/chats/${chat.id}/messages`)).status).toBe(404);
    expect((await other.patch(`/api/v1/chats/${chat.id}`, { title: 'x' })).status).toBe(404);
    expect((await other.del(`/api/v1/chats/${chat.id}`)).status).toBe(404);
    expect((await other.stream(chat.id, 'hi')).status).toBe(404);
    const forged = Buffer.from(JSON.stringify({ PK: `CHAT#${chat.id}`, SK: 'MSG#Z' })).toString('base64url');
    expect((await other.get(`/api/v1/chats/${chat.id}/messages?cursor=${forged}`)).status).toBe(404);
    const list = (await (await other.get('/api/v1/chats')).json()) as ChatList;
    expect(list.items.find((x) => x.id === chat.id)).toBeUndefined();
  });

  it('restores history from DynamoDB in chronological order', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    await readSse(await c.stream(chat.id, '一つ目'));
    await readSse(await c.stream(chat.id, '二つ目'));
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.map((m) => `${m.role}:${m.status}`)).toEqual([
      'user:completed',
      'assistant:completed',
      'user:completed',
      'assistant:completed',
    ]);
    expect(list.items[2]!.content).toBe('二つ目');
  });
});
