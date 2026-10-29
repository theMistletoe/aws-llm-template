import type { AgentEvent, AgentInvokeRequest } from '@ai-chat/agent-contracts';
import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { FixedModelProvider } from './fixed-model';
import { buildSystemPrompt, createStrandsRunner, fitContextToBudget, type StrandsRunnerOptions } from './strands-runner';
import type { WebSearchProvider, WebSource } from './web-search';

const limits = { maxResults: 5, maxQueryLength: 200, snippetMaxChars: 600, timeoutMs: 500, denyDomains: ['blocked.example'] };

const baseRequest = (message: string, overrides: Partial<AgentInvokeRequest['options']> = {}): AgentInvokeRequest => ({
  version: 1,
  requestId: 'r1',
  chatId: 'c1',
  userSub: 'u1',
  message,
  context: [],
  options: { allowWebSearch: true, maxToolCalls: 3, maxOutputTokens: 2048, ...overrides },
});

class RecordingSearch implements WebSearchProvider {
  queries: string[] = [];
  constructor(private readonly impl: (q: string, signal?: AbortSignal) => Promise<readonly WebSource[]> = async () => [
    { title: 'Doc', url: 'https://docs.example.com/a', snippet: 'snippet', publishedDate: '2026-10-01' },
  ]) {}
  search(query: string, signal?: AbortSignal) {
    this.queries.push(query);
    return this.impl(query, signal);
  }
}

async function run(options: Partial<StrandsRunnerOptions> & { model?: Model }, request: AgentInvokeRequest, signal = new AbortController().signal) {
  const model = options.model ?? new FixedModelProvider({ chunkDelayMs: 0 });
  const runner = createStrandsRunner({
    createModel: () => model,
    limits,
    inputBudgetChars: 24_000,
    now: () => new Date('2026-10-29T03:00:00Z'),
    ...options,
  });
  const events: AgentEvent[] = [];
  for await (const e of runner.run(request, signal)) events.push(e);
  return { events, model };
}

const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
const types = (events: AgentEvent[]) => [...new Set(events.map((e) => e.type))];

/** web_search を何度でも呼ぼうとするモデル（ツール回数上限の検証用） */
class GreedySearchModel extends Model<BaseModelConfig> {
  calls = 0;
  getConfig() {
    return { modelId: 'greedy' };
  }
  updateConfig() {}
  async *stream(_messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const n = this.calls++;
    const canSearch = (options?.toolSpecs ?? []).some((t) => t.name === 'web_search');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (canSearch && n < 5) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'web_search', toolUseId: `t${n}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ query: `${'q'.repeat(300)}${n}` }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'final' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  }
}

describe('createStrandsRunner', () => {
  it('streams a plain answer with usage and done', async () => {
    const { events } = await run({}, baseRequest('こんにちは'));
    expect(text(events)).toContain('ローカル固定モデルの応答です。「こんにちは」');
    expect(events.at(-2)).toMatchObject({ type: 'usage', searchCalls: 0 });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('runs web search and emits tool status and sources only from real tool results', async () => {
    const search = new RecordingSearch(async () => [
      { title: 'Doc', url: 'https://docs.example.com/a', snippet: 's', publishedDate: '2026-10-01' },
      { title: 'Bad', url: 'javascript:alert(1)', snippet: 'x' },
      { title: 'Denied', url: 'https://sub.blocked.example/x', snippet: 'x' },
      { title: 'Dup', url: 'https://docs.example.com/a', snippet: 'x' },
    ]);
    const { events } = await run({ search }, baseRequest('最新のニュースを検索して'));
    expect(events.filter((e) => e.type !== 'delta').map((e) => e.type)).toEqual([
      'tool_status',
      'tool_status',
      'source',
      'usage',
      'done',
    ]);
    expect(events.filter((e) => e.type === 'source')).toEqual([
      { type: 'source', title: 'Doc', url: 'https://docs.example.com/a', publishedDate: '2026-10-01' },
    ]);
    expect(text(events)).toContain('1. Doc');
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ searchCalls: 1 });
    expect(search.queries).toEqual(['最新のニュースを検索して']);
  });

  it('does not offer the search tool when web search is not allowed', async () => {
    const search = new RecordingSearch();
    const { events, model } = await run({ search }, baseRequest('最新のニュース', { allowWebSearch: false }));
    expect((model as FixedModelProvider).seenToolNames).toEqual([[]]);
    expect(search.queries).toEqual([]);
    expect(types(events)).not.toContain('tool_status');
  });

  it('exposes only the web_search tool to the model', async () => {
    const { model } = await run({ search: new RecordingSearch() }, baseRequest('こんにちは'));
    expect((model as FixedModelProvider).seenToolNames[0]).toEqual(['web_search']);
  });

  it('limits tool calls per answer and truncates queries to 200 characters', async () => {
    const search = new RecordingSearch();
    const { events } = await run({ search, model: new GreedySearchModel() }, baseRequest('x'));
    expect(search.queries).toHaveLength(3);
    expect(search.queries.every((q) => [...q].length === 200)).toBe(true);
    const statuses = events.flatMap((e) => (e.type === 'tool_status' ? [e.status] : []));
    expect(statuses.filter((s) => s === 'failed').length).toBeGreaterThanOrEqual(1);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ searchCalls: 3 });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('reports failed searches and answers without unverified facts', async () => {
    const search = new RecordingSearch(async () => {
      throw new Error('gateway down');
    });
    const { events } = await run({ search }, baseRequest('最新のニュース'));
    expect(events.filter((e) => e.type === 'tool_status').map((e) => (e as { status: string }).status)).toEqual([
      'running',
      'failed',
    ]);
    expect(text(events)).toContain('未確認');
    expect(types(events)).not.toContain('source');
  });

  it('times out slow searches', async () => {
    const search = new RecordingSearch((_q, signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const { events } = await run({ search, limits: { ...limits, timeoutMs: 30 } }, baseRequest('最新'));
    expect(events.find((e) => e.type === 'tool_status' && e.status === 'failed')).toBeDefined();
  });

  it('maps model errors, max tokens and cancellation', async () => {
    expect((await run({}, baseRequest('[[error]]'))).events.at(-1)).toEqual({ type: 'error', code: 'MODEL_ERROR', retryable: true });
    expect((await run({}, baseRequest('[[max_tokens]]'))).events.at(-1)).toEqual({ type: 'done', reason: 'max_tokens' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const { events } = await run({}, baseRequest('[[slow]] 長い応答'), ac.signal);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'cancelled' });
  });

  it('passes history to the model', async () => {
    const model = new FixedModelProvider({ chunkDelayMs: 0 });
    const request = {
      ...baseRequest('続き'),
      context: [
        { role: 'user' as const, content: '前の質問' },
        { role: 'assistant' as const, content: '前の回答' },
      ],
    };
    let seen: Message[] = [];
    const original = model.stream.bind(model);
    model.stream = (messages, options) => {
      seen = messages;
      return original(messages, options);
    };
    await run({ model }, request);
    expect(seen.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('fitContextToBudget', () => {
  const ctx = [
    { role: 'user' as const, content: 'a'.repeat(100) },
    { role: 'assistant' as const, content: 'b'.repeat(100) },
    { role: 'user' as const, content: 'c'.repeat(100) },
    { role: 'assistant' as const, content: 'd'.repeat(100) },
  ];

  it('keeps everything within budget', () => {
    expect(fitContextToBudget(ctx, 'm', 1000)).toEqual({ context: ctx, usedChars: 401 });
  });

  it('drops the oldest turns first and never starts with assistant', () => {
    const { context } = fitContextToBudget(ctx, 'm', 250);
    expect(context.map((m) => m.content[0])).toEqual(['c', 'd']);
    expect(fitContextToBudget(ctx, 'm'.repeat(500), 100).context).toEqual([]);
  });
});

describe('buildSystemPrompt', () => {
  it('includes date, citation and untrusted-data rules when search is enabled', () => {
    const p = buildSystemPrompt({ now: new Date('2026-10-29T03:00:00Z'), timeZone: 'Asia/Tokyo', searchEnabled: true });
    expect(p).toContain('2026年10月29日');
    expect(p).toContain('信頼できない外部データ');
    expect(p).toContain('[1]');
  });

  it('tells the model search is unavailable otherwise', () => {
    const p = buildSystemPrompt({ now: new Date(), timeZone: 'Asia/Tokyo', searchEnabled: false });
    expect(p).toContain('Web検索を利用できません');
    expect(p).not.toContain('web_search');
  });
});
