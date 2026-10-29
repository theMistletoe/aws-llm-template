import { SSE_HEARTBEAT, formatSseEvent } from '@ai-chat/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../deps';
import { parseQuery } from '../lib/validation';

const querySchema = z.object({ seconds: z.coerce.number().int().min(1).max(140).default(120) });

/**
 * PoC関門用の診断エンドポイント（既定OFF。DIAGNOSTICS_ENABLED=true のときだけ登録される）。
 * 指定秒数、データを送らずハートビート（コメント行）だけを送り続けてから done を返す。
 * CloudFront のオリジン応答タイムアウトをハートビートで回避できることを確認する（§9.4）。
 */
export function diagnosticsRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.get('/stream', (c) => {
    const { seconds } = parseQuery(c, querySchema);
    const encoder = new TextEncoder();
    const started = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    let finish: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(formatSseEvent('start', { seconds })));
        timer = setInterval(() => controller.enqueue(encoder.encode(SSE_HEARTBEAT)), deps.config.generation.heartbeatIntervalMs);
        finish = setTimeout(() => {
          clearInterval(timer);
          controller.enqueue(encoder.encode(formatSseEvent('done', { elapsedMs: Date.now() - started })));
          controller.close();
        }, seconds * 1000);
      },
      cancel() {
        clearInterval(timer);
        clearTimeout(finish);
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' },
    });
  });
  return r;
}
