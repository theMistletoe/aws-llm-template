import type { Chat, ChatList, MessageList } from '@ai-chat/contracts';
import { describe, expect, it } from 'vitest';
import { client, createHarness } from '../testing/fakes';

const uuidv7 = () => {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

async function loggedIn(email = 'owner@example.com', h = createHarness()) {
  const c = client(h);
  await c.login(email);
  return { h, c };
}

describe('chat CRUD', () => {
  it('creates, lists, renames and deletes chats', async () => {
    const { c } = await loggedIn();
    const created = await c.post('/api/v1/chats', {});
    expect(created.status).toBe(201);
    const chat = (await created.json()) as Chat;
    expect(chat.title).toBe('新しいチャット');
    expect(chat.id).toMatch(/^[0-9A-Z]{26}$/);

    const list = (await (await c.get('/api/v1/chats')).json()) as ChatList;
    expect(list.items.map((x) => x.id)).toEqual([chat.id]);

    const renamed = await c.patch(`/api/v1/chats/${chat.id}`, { title: '旅行の計画' });
    expect(((await renamed.json()) as Chat).title).toBe('旅行の計画');

    expect((await c.del(`/api/v1/chats/${chat.id}`)).status).toBe(204);
    expect((await c.get(`/api/v1/chats/${chat.id}`)).status).toBe(404);
    expect(((await (await c.get('/api/v1/chats')).json()) as ChatList).items).toEqual([]);
  });

  it('paginates the chat list with a cursor, newest first', async () => {
    const { h, c } = await loggedIn();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      h.clock.advance(1000);
      ids.push(((await (await c.post('/api/v1/chats', { title: `chat ${i}` })).json()) as Chat).id);
    }
    const p1 = (await (await c.get('/api/v1/chats?limit=2')).json()) as ChatList;
    expect(p1.items.map((x) => x.title)).toEqual(['chat 4', 'chat 3']);
    const p2 = (await (await c.get(`/api/v1/chats?limit=2&cursor=${p1.nextCursor}`)).json()) as ChatList;
    expect(p2.items.map((x) => x.title)).toEqual(['chat 2', 'chat 1']);
    const p3 = (await (await c.get(`/api/v1/chats?limit=2&cursor=${p2.nextCursor}`)).json()) as ChatList;
    expect(p3.items.map((x) => x.title)).toEqual(['chat 0']);
    expect(p3.nextCursor).toBeNull();
  });

  it('rejects tampered cursors that point at another user partition', async () => {
    const { c } = await loggedIn();
    const forged = Buffer.from(JSON.stringify({ GSI1PK: 'USER#victim', GSI1SK: 'x', PK: 'CHAT#x', SK: 'META' })).toString('base64url');
    const res = await c.get(`/api/v1/chats?cursor=${forged}`);
    expect(res.status).toBe(400);
    expect((await c.get('/api/v1/chats?cursor=%%%')).status).toBe(400);
  });

  it('isolates owners: other users get 404 for every operation', async () => {
    const h = createHarness();
    const owner = client(h);
    await owner.login('owner@example.com');
    const chat = (await (await owner.post('/api/v1/chats', {})).json()) as Chat;
    const other = client(h);
    await other.login('other@example.com');
    expect((await other.get(`/api/v1/chats/${chat.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/chats/${chat.id}`, { title: 'x' })).status).toBe(404);
    expect((await other.del(`/api/v1/chats/${chat.id}`)).status).toBe(404);
    expect((await other.get(`/api/v1/chats/${chat.id}/messages`)).status).toBe(404);
    expect((await other.post(`/api/v1/chats/${chat.id}/stream`, { requestId: uuidv7(), content: 'hi' })).status).toBe(404);
    expect(((await (await other.get('/api/v1/chats')).json()) as ChatList).items).toEqual([]);
    // 存在しないチャットとも区別できない
    expect((await other.get('/api/v1/chats/01JBQ7Z8X9Y0ABCDEFGHJKMNPQ')).status).toBe(404);
    expect((await other.get('/api/v1/chats/not-a-ulid')).status).toBe(404);
  });

  it('does not accept a user id from the request body', async () => {
    const { c } = await loggedIn();
    const res = await c.post('/api/v1/chats', { title: 'x', ownerSub: 'someone-else' });
    expect(res.status).toBe(400);
  });

  it('requires Origin for state-changing chat operations', async () => {
    const { h, c } = await loggedIn();
    const chat = (await (await c.post('/api/v1/chats', {})).json()) as Chat;
    const cookie = `__Host-session=${c.jar.get('__Host-session')}`;
    const res = await h.app.request(`/api/v1/chats/${chat.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it('pages messages from newest to oldest and returns each page in chronological order', async () => {
    const { h, c } = await loggedIn();
    const chat = (await (await c.post('/api/v1/chats', {})).json()) as Chat;
    for (let i = 0; i < 3; i++) {
      h.clock.advance(1000);
      await (await c.post(`/api/v1/chats/${chat.id}/stream`, { requestId: uuidv7(), content: `q${i}` })).text();
    }
    const p1 = (await (await c.get(`/api/v1/chats/${chat.id}/messages?limit=4`)).json()) as MessageList;
    expect(p1.items.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:q1',
      'assistant:こんにちは、世界',
      'user:q2',
      'assistant:こんにちは、世界',
    ]);
    const p2 = (await (await c.get(`/api/v1/chats/${chat.id}/messages?limit=4&cursor=${p1.nextCursor}`)).json()) as MessageList;
    expect(p2.items.map((m) => m.content)).toEqual(['q0', 'こんにちは、世界']);
    expect(p2.nextCursor).toBeNull();
  });

  it('reports usage with JST reset times', async () => {
    const { c } = await loggedIn();
    const usage = await (await c.get('/api/v1/usage')).json();
    expect(usage).toEqual({
      timeZone: 'Asia/Tokyo',
      daily: { date: '2026-10-29', requests: 0, requestLimit: 20, searches: 0, searchLimit: 20, resetsAt: '2026-10-29T15:00:00.000Z' },
      hourly: { hour: '2026-10-29T12', requests: 0, requestLimit: 10, resetsAt: '2026-10-29T04:00:00.000Z' },
    });
  });
});
