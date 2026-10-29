import type { AgentEvent, AgentInvokeRequest } from '@ai-chat/agent-contracts';
import type { Chat, MessageList, Usage } from '@ai-chat/contracts';
import { describe, expect, it } from 'vitest';
import { StartRunConflict, keys } from '../repositories/chat-repository';
import { client, createHarness, type TestHarness } from '../testing/fakes';
import { readSse } from '../testing/sse';
import { buildContext } from './generation-service';

let seq = 0;
const uuidv7 = () => {
  seq++;
  const hex = (Date.now().toString(16) + seq.toString(16).padStart(8, '0')).padStart(32, '0').slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

async function setup(config?: Record<string, string>) {
  const h = createHarness(config ? { config } : {});
  const c = client(h);
  await c.login('owner@example.com');
  const chat = (await (await c.post('/api/v1/chats', {})).json()) as Chat;
  const send = (content: string, requestId = uuidv7()) =>
    c.post(`/api/v1/chats/${chat.id}/stream`, { requestId, content });
  return { h, c, chat, send };
}

const until = async (cond: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function waitForAbortScript(first: AgentEvent[] = [{ type: 'delta', text: '途中まで' }]) {
  return async function* (_req: AgentInvokeRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    for (const e of first) yield e;
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  };
}

const assistantOf = (h: TestHarness) => [...h.chats.messages.values()].filter((m) => m.role === 'assistant');

describe('POST /api/v1/chats/:id/stream', () => {
  it('streams start/delta/done with SSE headers and persists the result', async () => {
    const { h, chat, send } = await setup();
    const res = await send('こんにちは、今日の予定は？');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const { events } = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'done']);
    const start = events[0]!.data as { assistantMessageId: string; chatId: string };
    expect(start.chatId).toBe(chat.id);
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: { messageId: start.assistantMessageId, finishReason: 'complete', usage: { inputTokens: 10, outputTokens: 5 } },
    });
    const saved = h.chats.messages.get(start.assistantMessageId)!;
    expect(saved).toMatchObject({ content: 'こんにちは、世界', status: 'completed', modelId: 'test-model' });
    expect(h.chats.metas.get(chat.id)!.activeRunId).toBeUndefined();
    // 最初の発言の先頭30文字でタイトルを自動設定
    expect(h.chats.metas.get(chat.id)!.title).toBe('こんにちは、今日の予定は？');
  });

  it('keeps the auto title after the first message and never overrides a user title', async () => {
    const { h, c, chat, send } = await setup();
    await (await send('あ'.repeat(40))).text();
    expect(h.chats.metas.get(chat.id)!.title).toBe('あ'.repeat(30));
    await (await send('二番目の質問')).text();
    expect(h.chats.metas.get(chat.id)!.title).toBe('あ'.repeat(30));
    const other = (await (await c.post('/api/v1/chats', { title: '自分で付けた' })).json()) as Chat;
    await (await c.post(`/api/v1/chats/${other.id}/stream`, { requestId: uuidv7(), content: '質問' })).text();
    expect(h.chats.metas.get(other.id)!.title).toBe('自分で付けた');
  });

  it('sends heartbeat comments while the agent is silent', async () => {
    const { h, send } = await setup({ HEARTBEAT_INTERVAL_MS: '20' });
    h.agent.script = async function* () {
      await new Promise((r) => setTimeout(r, 90));
      yield { type: 'delta', text: 'ok' };
      yield { type: 'done', reason: 'complete' };
    };
    const { raw, events } = await readSse(await send('hi'));
    expect(raw.match(/^: ping$/gm)?.length).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'done']);
  });

  it('forwards tool status and only safe, unique citations', async () => {
    const { h, send } = await setup();
    h.agent.script = async function* () {
      yield { type: 'tool_status', tool: 'web_search', status: 'running' };
      yield { type: 'tool_status', tool: 'web_search', status: 'done' };
      yield { type: 'source', title: 'AWS Docs', url: 'https://docs.aws.amazon.com/x', publishedDate: '2026-10-01' };
      yield { type: 'source', title: 'dup', url: 'https://docs.aws.amazon.com/x' };
      yield { type: 'source', title: 'evil', url: 'javascript:alert(1)' };
      yield { type: 'source', title: 'data', url: 'data:text/html,x' };
      yield { type: 'delta', text: '回答' };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1, searchCalls: 1 };
      yield { type: 'done', reason: 'complete' };
    };
    const { events } = await readSse(await send('最新情報'));
    expect(events.filter((e) => e.event === 'source').map((e) => e.data)).toEqual([
      { title: 'AWS Docs', url: 'https://docs.aws.amazon.com/x', publishedDate: '2026-10-01' },
    ]);
    expect(events.filter((e) => e.event === 'tool_status')).toHaveLength(2);
    const msg = assistantOf(h)[0]!;
    expect(msg.citations).toEqual([{ title: 'AWS Docs', url: 'https://docs.aws.amazon.com/x', publishedDate: '2026-10-01' }]);
    expect(msg.searchedAt).toBeDefined();
  });

  it('marks failed web searches on the message', async () => {
    const { h, c, chat, send } = await setup();
    h.agent.script = async function* () {
      yield { type: 'tool_status', tool: 'web_search', status: 'running' };
      yield { type: 'tool_status', tool: 'web_search', status: 'failed' };
      yield { type: 'delta', text: '検索できませんでした' };
      yield { type: 'done', reason: 'complete' };
    };
    await (await send('最新')).text();
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.at(-1)).toMatchObject({ status: 'completed', searchFailed: true });
  });

  it('rejects duplicate requestIds', async () => {
    const { send } = await setup();
    const id = uuidv7();
    await (await send('a', id)).text();
    const dup = await send('a', id);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('DUPLICATE_REQUEST');
  });

  it('allows only one generation per chat and refuses delete while generating', async () => {
    const { h, c, chat, send } = await setup();
    h.agent.script = waitForAbortScript();
    const first = await send('長い処理');
    const reader = first.body!.getReader();
    await reader.read();
    const second = await send('割り込み');
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('CHAT_BUSY');
    expect((await c.del(`/api/v1/chats/${chat.id}`)).status).toBe(409);
    await reader.cancel();
    await until(() => h.chats.finishCalls.length === 1);
    expect((await c.del(`/api/v1/chats/${chat.id}`)).status).toBe(204);
  });

  it('handles client disconnects: interrupted, quota consumed, AgentCore session stopped', async () => {
    const { h, c, chat, send } = await setup();
    h.agent.script = waitForAbortScript();
    const res = await send('止める');
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await until(() => h.chats.finishCalls.length === 1);
    expect(h.chats.finishCalls[0]).toMatchObject({ status: 'interrupted', content: '途中まで' });
    expect(h.agent.stopped).toEqual([{ chatId: chat.id, userSub: 'sub-owner@example.com' }]);
    const usage = (await (await c.get('/api/v1/usage')).json()) as Usage;
    expect(usage.daily.requests).toBe(1);
    expect(usage.hourly.requests).toBe(1);
  });

  it('times out long generations with MODEL_TIMEOUT', async () => {
    const { h, send } = await setup({ GENERATION_TIMEOUT_MS: '40', AGENT_READ_TIMEOUT_MS: '50', BFF_MAX_DURATION_MS: '100' });
    h.agent.script = waitForAbortScript();
    const { events } = await readSse(await send('遅い'));
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'MODEL_TIMEOUT', message: '応答がタイムアウトしました', retryable: true },
    });
    expect(assistantOf(h)[0]!.status).toBe('failed');
    expect(h.agent.stopped).toHaveLength(1);
  });

  it.each([
    ['agent error event', async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'error', code: 'MODEL_ERROR', retryable: false };
    }, 'AGENT_ERROR'],
    ['agent timeout event', async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'error', code: 'MODEL_TIMEOUT', retryable: true };
    }, 'MODEL_TIMEOUT'],
    ['thrown error', async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'delta', text: 'x' };
      throw new Error('boom');
    }, 'AGENT_ERROR'],
    ['stream ended without done', async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'delta', text: 'x' };
    }, 'AGENT_ERROR'],
  ])('maps %s to a failed message', async (_name, script, code) => {
    const { h, send } = await setup();
    h.agent.script = script;
    const { events } = await readSse(await send('q'));
    expect(events.at(-1)?.event).toBe('error');
    expect((events.at(-1)!.data as { code: string }).code).toBe(code);
    expect(assistantOf(h)[0]!.status).toBe('failed');
    expect(h.chats.metas.values().next().value!.activeRunId).toBeUndefined();
  });

  it('reports max_tokens as a completed answer', async () => {
    const { h, send } = await setup();
    h.agent.script = async function* () {
      yield { type: 'delta', text: '長い' };
      yield { type: 'done', reason: 'max_tokens' };
    };
    const { events } = await readSse(await send('q'));
    expect((events.at(-1)!.data as { finishReason: string }).finishReason).toBe('max_tokens');
    expect(assistantOf(h)[0]!.status).toBe('completed');
  });

  it('enforces the daily quota with a JST reset time (and counts failures)', async () => {
    const { h, c, send } = await setup({ QUOTA_DAILY_REQUESTS: '2' });
    h.agent.script = async function* () {
      yield { type: 'error', code: 'MODEL_ERROR', retryable: true };
    };
    await (await send('1')).text();
    await (await send('2')).text();
    const res = await send('3');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; retryAfter: string } };
    expect(body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', retryAfter: '2026-10-29T15:00:00.000Z' });
    // JSTの日付が変わると再開できる
    h.clock.set('2026-10-29T15:00:01.000Z');
    await c.login('owner@example.com'); // セッションは非操作30分で失効するため再ログイン
    expect((await send('4')).status).toBe(200);
  });

  it('enforces the hourly quota', async () => {
    const { h, c, send } = await setup({ QUOTA_HOURLY_REQUESTS: '1' });
    await (await send('1')).text();
    const res = await send('2');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { retryAfter: string } }).error.retryAfter).toBe('2026-10-29T04:00:00.000Z');
    h.clock.advance(3600_000);
    await c.login('owner@example.com');
    expect((await send('3')).status).toBe(200);
  });

  it('disables web search once the daily search quota is used up', async () => {
    const { h, c, send } = await setup({ QUOTA_DAILY_SEARCHES: '2' });
    h.agent.script = async function* () {
      yield { type: 'delta', text: 'x' };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1, searchCalls: 3 };
      yield { type: 'done', reason: 'complete' };
    };
    await (await send('最新1')).text();
    expect(h.agent.requests[0]!.options.allowWebSearch).toBe(true);
    await (await send('最新2')).text();
    expect(h.agent.requests[1]!.options.allowWebSearch).toBe(false);
    const usage = (await (await c.get('/api/v1/usage')).json()) as Usage;
    expect(usage.daily.searches).toBe(6);
  });

  it('passes recent completed history as context and never the raw session/user data', async () => {
    const { h, send } = await setup();
    await (await send('最初の質問')).text();
    h.agent.script = async function* () {
      yield { type: 'error', code: 'MODEL_ERROR', retryable: true };
    };
    await (await send('失敗する質問')).text();
    h.agent.script = async function* () {
      yield { type: 'delta', text: 'ok' };
      yield { type: 'done', reason: 'complete' };
    };
    await (await send('3つ目')).text();
    const req = h.agent.requests[2]!;
    expect(req.message).toBe('3つ目');
    // 回答が失敗したuser発言（未回答）は文脈に含めない
    expect(req.context).toEqual([
      { role: 'user', content: '最初の質問' },
      { role: 'assistant', content: 'こんにちは、世界' },
    ]);
    expect(req.userSub).toBe('sub-owner@example.com');
    expect(req.options).toEqual({ allowWebSearch: true, maxToolCalls: 3, maxOutputTokens: 2048 });
    expect(Object.keys(req).sort()).toEqual(['chatId', 'context', 'message', 'options', 'requestId', 'userSub', 'version']);
  });

  it('recovers stale locks lazily (interrupted) before listing or generating', async () => {
    const { h, c, chat, send } = await setup();
    h.agent.script = waitForAbortScript();
    const res = await send('クラッシュ');
    const reader = res.body!.getReader();
    await reader.read();
    // BFFが異常終了したとみなし、ストリームを放置したまま時刻をロック期限後へ進める
    const meta = h.chats.metas.get(chat.id)!;
    const runId = meta.activeRunId!;
    h.agent.script = async function* () {
      yield { type: 'delta', text: 'new' };
      yield { type: 'done', reason: 'complete' };
    };
    // ロック期限内は生成中
    expect((await send('まだ')).status).toBe(409);
    h.clock.advance(181_000);
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.at(-1)).toMatchObject({ role: 'assistant', status: 'interrupted' });
    expect(h.chats.runs.get(`${chat.id}/${runId}`)!.status).toBe('interrupted');
    expect(h.chats.metas.get(chat.id)!.activeRunId).toBeUndefined();
    expect((await send('再開')).status).toBe(200);
    void reader.cancel();
    expect(keys.run(runId)).toBe(`RUN#${runId}`);
  });

  it('validates the request body', async () => {
    const { send } = await setup();
    expect((await send('')).status).toBe(400);
    expect((await send('a'.repeat(4001))).status).toBe(400);
    expect((await send('ok', 'not-a-uuid')).status).toBe(400);
  });
});

describe('buildContext', () => {
  const m = (role: 'user' | 'assistant', content: string) => ({ role, content });

  it('merges consecutive roles, starts with user and ends with assistant', () => {
    expect(buildContext([m('assistant', 'a0'), m('user', 'u1'), m('user', 'u2'), m('assistant', 'a1'), m('user', 'u3')], 20)).toEqual([
      m('user', 'u1\n\nu2'),
      m('assistant', 'a1'),
    ]);
  });

  it('limits to the most recent messages', () => {
    const history = Array.from({ length: 30 }, (_, i) => m(i % 2 === 0 ? 'user' : 'assistant', String(i)));
    const ctx = buildContext(history, 20);
    expect(ctx).toHaveLength(20);
    expect(ctx[0]).toEqual(m('user', '10'));
    expect(ctx.at(-1)).toEqual(m('assistant', '29'));
  });

  it('returns empty context for empty history', () => {
    expect(buildContext([], 20)).toEqual([]);
    expect(buildContext([m('user', 'x')], 20)).toEqual([]);
  });
});

describe('conflict diagnosis when the store gives no cancellation reasons', () => {
  async function setupUnknown(config?: Record<string, string>, before?: (h: TestHarness, chatId: string) => void) {
    const ctx = await setup(config);
    const original = ctx.h.chats.startRun.bind(ctx.h.chats);
    ctx.h.chats.startRun = async (p) => {
      before?.(ctx.h, p.chatId);
      try {
        await original(p);
      } catch (e) {
        if (e instanceof StartRunConflict) throw new StartRunConflict(['unknown']);
        throw e;
      }
    };
    return ctx;
  }
  const codeOf = async (res: Response) => ({ status: res.status, ...((await res.json()) as { error: { code: string; retryAfter?: string } }).error });

  it('detects duplicates', async () => {
    const { send } = await setupUnknown();
    const id = uuidv7();
    await (await send('a', id)).text();
    expect(await codeOf(await send('a', id))).toMatchObject({ status: 409, code: 'DUPLICATE_REQUEST' });
  });

  it('detects daily and hourly quota', async () => {
    const daily = await setupUnknown({ QUOTA_DAILY_REQUESTS: '1' });
    await (await daily.send('a')).text();
    expect(await codeOf(await daily.send('b'))).toMatchObject({ status: 429, code: 'QUOTA_EXCEEDED', retryAfter: '2026-10-29T15:00:00.000Z' });
    const hourly = await setupUnknown({ QUOTA_HOURLY_REQUESTS: '1' });
    await (await hourly.send('a')).text();
    expect(await codeOf(await hourly.send('b'))).toMatchObject({ status: 429, retryAfter: '2026-10-29T04:00:00.000Z' });
  });

  it('detects a lock taken concurrently and a chat deleted concurrently', async () => {
    const busy = await setupUnknown(undefined, (h, chatId) => {
      Object.assign(h.chats.metas.get(chatId)!, { activeRunId: 'other', lockExpiresAt: h.clock.now().getTime() + 60_000 });
    });
    expect(await codeOf(await busy.send('a'))).toMatchObject({ status: 409, code: 'CHAT_BUSY' });
    const gone = await setupUnknown(undefined, (h, chatId) => {
      h.chats.metas.get(chatId)!.deletedAt = h.clock.now().toISOString();
    });
    expect(await codeOf(await gone.send('a'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('citation limits', () => {
  it('keeps at most 10 citations and falls back to the URL for empty titles', async () => {
    const { h, send } = await setup();
    h.agent.script = async function* () {
      for (let i = 0; i < 12; i++) yield { type: 'source', title: i === 0 ? '' : `t${i}`, url: `https://example.com/${i}` };
      yield { type: 'done', reason: 'complete' };
    };
    const { events } = await readSse(await send('最新'));
    const sources = events.filter((e) => e.event === 'source').map((e) => e.data as { title: string });
    expect(sources).toHaveLength(10);
    expect(sources[0]!.title).toBe('https://example.com/0');
  });
});
