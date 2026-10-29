import type { AgentEvent, AgentRunner } from '@ai-chat/agent-contracts';
import { describe, expect, it } from 'vitest';
import { createAgentApp } from './app';

const valid = {
  version: 1,
  requestId: 'r1',
  chatId: 'c1',
  userSub: 'u1',
  message: 'hi',
  context: [],
  options: { allowWebSearch: false, maxToolCalls: 0, maxOutputTokens: 100 },
};

const runnerOf = (gen: (signal: AbortSignal) => AsyncGenerator<AgentEvent>): AgentRunner => ({ run: (_r, s) => gen(s) });
const quiet = () => undefined;

describe('agent app (AgentCore service contract)', () => {
  it('responds to /ping', async () => {
    const app = createAgentApp({ runner: runnerOf(async function* () {}), log: quiet });
    const res = await app.request('/ping');
    expect(await res.json()).toMatchObject({ status: 'Healthy' });
  });

  it('rejects invalid invocations', async () => {
    const app = createAgentApp({ runner: runnerOf(async function* () {}), log: quiet });
    expect((await app.request('/invocations', { method: 'POST', body: 'x' })).status).toBe(400);
    const res = await app.request('/invocations', { method: 'POST', body: JSON.stringify({ ...valid, version: 2 }) });
    expect(res.status).toBe(400);
  });

  it('streams events as SSE with heartbeats and reports busy while running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = createAgentApp({
      heartbeatMs: 10,
      log: quiet,
      runner: runnerOf(async function* () {
        yield { type: 'delta', text: 'a' };
        await gate;
        yield { type: 'done', reason: 'complete' };
      }),
    });
    const res = await app.request('/invocations', { method: 'POST', body: JSON.stringify(valid) });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const pending = res.text();
    await new Promise((r) => setTimeout(r, 40));
    expect(await (await app.request('/ping')).json()).toMatchObject({ status: 'HealthyBusy' });
    release();
    const body = await pending;
    expect(body).toContain('event: delta\ndata: {"type":"delta","text":"a"}');
    expect(body).toContain(': ping');
    expect(body.trim().endsWith('data: {"type":"done","reason":"complete"}')).toBe(true);
    expect(await (await app.request('/ping')).json()).toMatchObject({ status: 'Healthy' });
  });

  it('converts runner exceptions into an error event', async () => {
    const app = createAgentApp({
      log: quiet,
      runner: runnerOf(async function* () {
        yield { type: 'delta', text: 'a' };
        throw new Error('boom');
      }),
    });
    const body = await (await app.request('/invocations', { method: 'POST', body: JSON.stringify(valid) })).text();
    expect(body).toContain('"type":"error","code":"AGENT_ERROR"');
  });

  it('aborts the runner when the client disconnects', async () => {
    let aborted = false;
    const app = createAgentApp({
      log: quiet,
      runner: runnerOf(async function* (signal) {
        yield { type: 'delta', text: 'a' };
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        aborted = true;
      }),
    });
    const res = await app.request('/invocations', { method: 'POST', body: JSON.stringify(valid) });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true);
  });
});
