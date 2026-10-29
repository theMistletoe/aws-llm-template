import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { encodeAgentEvent, type AgentEvent, type AgentInvokeRequest } from '@ai-chat/agent-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCoreRunner } from './agentcore-runner';
import { HttpAgentRunner } from './http-agent-runner';

const request: AgentInvokeRequest = {
  version: 1,
  requestId: 'r1',
  chatId: '01JBQ7Z8X9Y0ABCDEFGHJKMNPQ',
  userSub: 'sub',
  message: 'hi',
  context: [],
  options: { allowWebSearch: true, maxToolCalls: 3, maxOutputTokens: 2048 },
};

function sseStream(parts: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const events: AgentEvent[] = [
  { type: 'delta', text: 'あ' },
  { type: 'usage', inputTokens: 1, outputTokens: 1, searchCalls: 0 },
  { type: 'done', reason: 'complete' },
];
const wire = events.map(encodeAgentEvent).join('');

afterEach(() => vi.unstubAllGlobals());

describe('HttpAgentRunner', () => {
  it('posts the contract to /invocations with the session header and parses SSE (ignoring junk and pings)', async () => {
    const fetchMock = vi.fn(async () => new Response(sseStream([': ping\n\n', wire.slice(0, 7), wire.slice(7), 'event: x\ndata: {}\n\n'])));
    vi.stubGlobal('fetch', fetchMock);
    const out = await collect(new HttpAgentRunner('http://localhost:8080', 1000).run(request, new AbortController().signal));
    expect(out).toEqual(events);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://localhost:8080/invocations');
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect((init.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toMatch(/^chat-01JBQ7Z8X9Y0ABCDEFGHJKMNPQ-[0-9a-f]{16}$/);
  });

  it('maps HTTP and network failures to error events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })));
    expect(await collect(new HttpAgentRunner('http://x', 1000).run(request, new AbortController().signal))).toEqual([
      { type: 'error', code: 'AGENT_ERROR', retryable: true },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    }));
    expect(await collect(new HttpAgentRunner('http://x', 1000).run(request, new AbortController().signal))).toEqual([
      { type: 'error', code: 'MODEL_TIMEOUT', retryable: true },
    ]);
  });

  it('rethrows when the caller aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }));
    await expect(collect(new HttpAgentRunner('http://x', 1000).run(request, ac.signal))).rejects.toThrow();
  });
});

describe('AgentCoreRunner', () => {
  it('invokes the runtime with a deterministic session id and streams events', async () => {
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === 'InvokeAgentRuntimeCommand') {
        return { response: { transformToWebStream: () => sseStream([wire]) } };
      }
      return {};
    });
    const runner = new AgentCoreRunner({
      client: { send } as unknown as BedrockAgentCoreClient,
      runtimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/agent-abc',
      qualifier: 'DEFAULT',
      readTimeoutMs: 1000,
    });
    expect(await collect(runner.run(request, new AbortController().signal))).toEqual(events);
    const input = send.mock.calls[0]![0].input;
    expect(input).toMatchObject({
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/agent-abc',
      contentType: 'application/json',
      accept: 'text/event-stream',
    });
    expect(input).not.toHaveProperty('qualifier');
    expect(JSON.parse(new TextDecoder().decode(input.payload as Uint8Array))).toEqual(request);
    await runner.stopSession({ chatId: request.chatId, userSub: 'sub' });
    expect(send.mock.calls[1]![0].constructor.name).toBe('StopRuntimeSessionCommand');
    expect(send.mock.calls[1]![0].input.runtimeSessionId).toBe(input.runtimeSessionId);
  });

  it.each([
    ['ThrottlingException', 'MODEL_THROTTLED', true],
    ['AccessDeniedException', 'AGENT_ERROR', false],
    ['TimeoutError', 'MODEL_TIMEOUT', true],
  ])('maps %s to %s', async (name, code, retryable) => {
    const runner = new AgentCoreRunner({
      client: { send: async () => { throw Object.assign(new Error(name), { name }); } } as unknown as BedrockAgentCoreClient,
      runtimeArn: 'arn',
      qualifier: 'live',
      readTimeoutMs: 1000,
    });
    expect(await collect(runner.run(request, new AbortController().signal))).toEqual([{ type: 'error', code, retryable }]);
  });
});
