import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../test/server';
import { sse, sseResponse, sseStream } from '../test/utils';
import { ApiRequestError, UNAUTHENTICATED_EVENT, apiFetch, buildRequest } from './client';
import { StreamInterruptedError, streamChat } from './stream';

afterEach(() => vi.unstubAllEnvs());

async function collect(chunks: string[]) {
  server.use(http.post('*/api/v1/chats/C/stream', () => sseResponse(sseStream(chunks))));
  const events: string[] = [];
  const result = await streamChat({
    chatId: 'C',
    requestId: 'r',
    content: 'x',
    signal: new AbortController().signal,
    onEvent: (e) => events.push(`${e.event}:${JSON.stringify(e.data)}`),
  });
  return { events, result };
}

describe('streamChat (SSE over fetch)', () => {
  it('handles events in any order, ignores heartbeats and unknown events', async () => {
    const { events, result } = await collect([
      sse('start', { requestId: 'r', chatId: 'C', userMessageId: 'U', assistantMessageId: 'A' }),
      ': ping\n\n',
      sse('source', { title: 't', url: 'https://a.example' }),
      sse('mystery', { x: 1 }),
      sse('delta', { text: 'a' }),
      sse('done', { messageId: 'A', finishReason: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }),
      sse('delta', { text: 'ignored after done' }),
    ]);
    expect(result).toBe('done');
    expect(events.map((e) => e.split(':')[0])).toEqual(['start', 'source', 'delta', 'done']);
  });

  it('reassembles events split across chunks including UTF-8 boundaries', async () => {
    const whole = sse('delta', { text: '日本語の応答🙂' }) + sse('error', { code: 'AGENT_ERROR', message: 'm', retryable: true });
    const bytes = new TextEncoder().encode(whole);
    server.use(
      http.post('*/api/v1/chats/C/stream', () =>
        sseResponse(
          new ReadableStream({
            start(c) {
              for (const b of bytes) c.enqueue(new Uint8Array([b]));
              c.close();
            },
          }),
        ),
      ),
    );
    const events: unknown[] = [];
    const result = await streamChat({ chatId: 'C', requestId: 'r', content: 'x', signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(result).toBe('error');
    expect(events[0]).toEqual({ event: 'delta', data: { text: '日本語の応答🙂' } });
  });

  it('throws StreamInterruptedError when the stream ends without done/error', async () => {
    await expect(collect([sse('delta', { text: 'a' })])).rejects.toBeInstanceOf(StreamInterruptedError);
  });

  it('throws ApiRequestError for HTTP errors before streaming', async () => {
    server.use(
      http.post('*/api/v1/chats/C/stream', () =>
        HttpResponse.json({ error: { code: 'CHAT_BUSY', message: 'busy', requestId: 'x', retryable: true } }, { status: 409 }),
      ),
    );
    const err = await streamChat({ chatId: 'C', requestId: 'r', content: 'x', signal: new AbortController().signal, onEvent: () => undefined }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe('CHAT_BUSY');
  });
});

describe('apiFetch', () => {
  it('sends same-origin credentials and JSON, and returns undefined for 204', async () => {
    let seen: Request | undefined;
    server.use(
      http.post('*/api/x', ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(apiFetch('/api/x', { method: 'POST', body: { a: 1 } })).resolves.toBeUndefined();
    expect(seen!.headers.get('content-type')).toBe('application/json');
    expect(seen!.headers.get('x-amz-content-sha256')).toBeNull();
  });

  it('adds the payload hash header for Function URL deployments', async () => {
    vi.stubEnv('VITE_PAYLOAD_HASH_HEADER', 'true');
    const init = await buildRequest('POST', { a: 1 });
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  it('notifies the app on 401 and maps network failures', async () => {
    const listener = vi.fn();
    window.addEventListener(UNAUTHENTICATED_EVENT, listener);
    server.use(http.get('*/api/y', () => HttpResponse.json({}, { status: 401 })));
    await expect(apiFetch('/api/y')).rejects.toMatchObject({ status: 401, code: 'HTTP_ERROR' });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener(UNAUTHENTICATED_EVENT, listener);
    server.use(http.get('*/api/z', () => HttpResponse.error()));
    await expect(apiFetch('/api/z')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
