import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { MessageList, Usage } from '@ai-chat/contracts';
import { FIXED_REPLY_PREFIX } from '@ai-chat/test-fixtures';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';
import { startLocalApi } from '../../apps/api/src/local';
import { LOCAL_AWS_ENV } from '../../local/lib';
import { API_ENV, LIMITED_API, TABLES } from './env';
import { Client, db, readSse, until } from './helpers';

/** keep-alive接続も含めて閉じる（再起動後に古いソケットを再利用させない） */
async function stop(server: Awaited<ReturnType<typeof startLocalApi>>) {
  const done = new Promise<void>((r) => server.close(() => r()));
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await done;
  await new Promise((r) => setTimeout(r, 50));
}

describe('SSE generation through the local Strands agent', () => {
  it('streams start → delta… → done, persists the answer and sets the title', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const res = await c.stream(chat.id, 'こんにちは、自己紹介して');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    const { events } = await readSse(res);
    expect(events[0]!.event).toBe('start');
    expect(events.at(-1)!.event).toBe('done');
    expect(events.filter((e) => e.event === 'delta').length).toBeGreaterThan(3);
    const text = events.flatMap((e) => (e.event === 'delta' ? [e.data.text] : [])).join('');
    expect(text.startsWith(FIXED_REPLY_PREFIX)).toBe(true);
    const meta = await db.send(new GetCommand({ TableName: TABLES.data, Key: { PK: `CHAT#${chat.id}`, SK: 'META' } }));
    expect(meta.Item).toMatchObject({ title: 'こんにちは、自己紹介して', titleSource: 'auto' });
    expect(meta.Item!.activeRunId).toBeUndefined();
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.at(-1)).toMatchObject({ role: 'assistant', status: 'completed', content: text });
  });

  it('rejects duplicate requestIds and concurrent generations in the same chat', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const id = uuidv7();
    await readSse(await c.stream(chat.id, 'a', id));
    expect((await c.stream(chat.id, 'a', id)).status).toBe(409);

    const slow = await c.stream(chat.id, '[[slow]] ゆっくり');
    const reader = slow.body!.getReader();
    await reader.read();
    const busy = await c.stream(chat.id, '割り込み');
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('CHAT_BUSY');
    await reader.cancel();
  });

  it('marks the message interrupted when the client disconnects mid-stream', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const controller = new AbortController();
    const res = await c.stream(chat.id, '[[slow]] 長い回答', uuidv7(), controller.signal);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    const last = await until(async () => {
      const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
      const m = list.items.at(-1);
      return m && m.status !== 'streaming' ? m : undefined;
    });
    expect(last.status).toBe('interrupted');
    // 中断も消費扱い
    const usage = (await (await c.get('/api/v1/usage')).json()) as Usage;
    expect(usage.daily.requests).toBe(1);
  });

  it('sends heartbeats while the model is silent', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const { raw, events } = await readSse(await c.stream(chat.id, '[[pause:1200]] 考え中'));
    expect(raw.match(/^: ping$/gm)?.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)!.event).toBe('done');
  });

  it('maps model errors to an error event and a failed message', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const { events } = await readSse(await c.stream(chat.id, '[[error]]'));
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'AGENT_ERROR' } });
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.at(-1)!.status).toBe('failed');
  });

  it('enforces quotas (429 with JST reset time)', async () => {
    const c = new Client(LIMITED_API);
    await c.login();
    const chat = await c.createChat();
    await readSse(await c.stream(chat.id, '1'));
    await readSse(await c.stream(chat.id, '2'));
    const res = await c.stream(chat.id, '3');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; retryAfter: string } };
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(new Date(body.error.retryAfter).getUTCMinutes()).toBe(0);
  });

  it('keeps history across an API restart', async () => {
    const port = 13002;
    const env = { ...LOCAL_AWS_ENV, ...API_ENV };
    let server = await startLocalApi({ port, env });
    const c = new Client(`http://127.0.0.1:${port}`);
    await c.login();
    const chat = await c.createChat();
    await readSse(await c.stream(chat.id, '再起動前の質問'));
    await stop(server);
    server = await startLocalApi({ port, env });
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.map((m) => m.content)[0]).toBe('再起動前の質問');
    await stop(server);
  });
});
