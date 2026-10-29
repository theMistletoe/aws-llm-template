import { describe, expect, it } from 'vitest';
import { SseParser, formatSseEvent, parseStreamEvent, readSseFrames } from './sse';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const f of readSseFrames(stream)) out.push(f);
  return out;
}

describe('SseParser', () => {
  it('parses events split at arbitrary chunk boundaries', () => {
    const text = formatSseEvent('delta', { text: 'こんにちは' }) + formatSseEvent('done', { ok: true });
    for (let cut = 1; cut < text.length; cut++) {
      const p = new SseParser();
      const frames = [...p.feed(text.slice(0, cut)), ...p.feed(text.slice(cut))];
      expect(frames).toEqual([
        { event: 'delta', data: '{"text":"こんにちは"}' },
        { event: 'done', data: '{"ok":true}' },
      ]);
    }
  });

  it('ignores comment lines (heartbeat) and handles CRLF / CR line endings', () => {
    const p = new SseParser();
    const frames = [
      ...p.feed(': ping\r\n\r\nevent: a\r'),
      ...p.feed('\ndata: 1\r\rdata: x\n'),
      ...p.feed('data: y\n\n'),
    ];
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: 'x\ny' },
    ]);
  });

  it('dispatches nothing for an event without data and drops incomplete trailing events', () => {
    const p = new SseParser();
    expect(p.feed('event: x\n\n')).toEqual([]);
    expect(p.feed('event: y\ndata: 1')).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it('keeps the last id', () => {
    const p = new SseParser();
    expect(p.feed('id: 7\ndata: a\n\n')).toEqual([{ event: 'message', data: 'a', id: '7' }]);
  });
});

describe('readSseFrames', () => {
  it('decodes UTF-8 multibyte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode(formatSseEvent('delta', { text: '日本語🙂' }));
    const chunks = [...bytes].map((b) => new Uint8Array([b]));
    const frames = await collect(streamOf(chunks));
    expect(frames).toHaveLength(1);
    expect(parseStreamEvent(frames[0]!)).toEqual({ event: 'delta', data: { text: '日本語🙂' } });
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    let pull = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pull++;
        c.enqueue(new TextEncoder().encode(formatSseEvent('delta', { text: String(pull) })));
      },
    });
    const seen: string[] = [];
    for await (const f of readSseFrames(stream, controller.signal)) {
      seen.push(f.data);
      if (seen.length === 2) controller.abort();
    }
    expect(seen).toHaveLength(2);
  });
});

describe('parseStreamEvent', () => {
  it('validates known events', () => {
    expect(parseStreamEvent({ event: 'tool_status', data: '{"tool":"web_search","status":"running"}' })).toEqual({
      event: 'tool_status',
      data: { tool: 'web_search', status: 'running' },
    });
    expect(
      parseStreamEvent({
        event: 'done',
        data: '{"messageId":"m","finishReason":"complete","usage":{"inputTokens":1,"outputTokens":2}}',
      })?.event,
    ).toBe('done');
  });

  it('rejects unknown events, bad JSON and bad shapes', () => {
    expect(parseStreamEvent({ event: 'secret', data: '{}' })).toBeNull();
    expect(parseStreamEvent({ event: 'delta', data: '{' })).toBeNull();
    expect(parseStreamEvent({ event: 'delta', data: '{"text":1}' })).toBeNull();
    expect(parseStreamEvent({ event: 'tool_status', data: '{"tool":"shell","status":"running"}' })).toBeNull();
  });
});
