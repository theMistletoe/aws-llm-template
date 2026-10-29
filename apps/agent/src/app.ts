import { agentInvokeRequestSchema, encodeAgentEvent, type AgentRunner } from '@ai-chat/agent-contracts';
import { Hono } from 'hono';

type Log = (event: string, fields: Record<string, unknown>) => void;

const defaultLog: Log = (event, fields) =>
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event, ...fields })}\n`);

/**
 * AgentCore Runtime のサービス契約（GET /ping, POST /invocations）を実装するHTTPアプリ（§6.4）。
 * BFFとは別サーバーとして起動する。/invocations は AgentEvent をSSEで逐次返す。
 */
export function createAgentApp(deps: { runner: AgentRunner; heartbeatMs?: number; log?: Log }) {
  const log = deps.log ?? defaultLog;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  let active = 0;
  let lastStatusChange = Math.floor(Date.now() / 1000);
  const setActive = (delta: number) => {
    const before = active > 0;
    active += delta;
    if (before !== active > 0) lastStatusChange = Math.floor(Date.now() / 1000);
  };

  const app = new Hono();

  app.get('/ping', (c) =>
    c.json({ status: active > 0 ? 'HealthyBusy' : 'Healthy', time_of_last_update: lastStatusChange }),
  );

  app.post('/invocations', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const parsed = agentInvokeRequestSchema.safeParse(body);
    if (!parsed.success) {
      log('invocation_rejected', { reason: 'validation' });
      return c.json({ error: 'invalid request' }, 400);
    }
    const request = parsed.data;
    const abort = new AbortController();
    const encoder = new TextEncoder();
    const started = performance.now();
    c.req.raw.signal.addEventListener('abort', () => abort.abort(new Error('client disconnected')), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
            abort.abort(new Error('stream closed'));
            return;
          }
          clearTimeout(timer);
          timer = setTimeout(() => write(': ping\n\n'), heartbeatMs);
        };
        setActive(1);
        void (async () => {
          let outcome = 'complete';
          let searchCalls = 0;
          let usage = { inputTokens: 0, outputTokens: 0 };
          try {
            for await (const ev of deps.runner.run(request, abort.signal)) {
              if (ev.type === 'usage') {
                searchCalls = ev.searchCalls;
                usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
              }
              if (ev.type === 'done') outcome = ev.reason;
              if (ev.type === 'error') outcome = `error:${ev.code}`;
              write(encodeAgentEvent(ev));
            }
          } catch (e) {
            outcome = abort.signal.aborted ? 'cancelled' : 'error:AGENT_ERROR';
            if (!abort.signal.aborted) write(encodeAgentEvent({ type: 'error', code: 'AGENT_ERROR', retryable: true }));
            log('invocation_failed', { errorClass: (e as Error).name });
          } finally {
            clearTimeout(timer);
            setActive(-1);
            log('invocation_finished', {
              requestId: request.requestId,
              outcome,
              latencyMs: Math.round(performance.now() - started),
              usage,
              toolCalls: searchCalls,
            });
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          }
        })();
      },
      cancel: () => abort.abort(new Error('client disconnected')),
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return app;
}
