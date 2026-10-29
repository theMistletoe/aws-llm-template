import { parseStreamEvent, readSseFrames, type StreamEvent } from '@ai-chat/contracts';
import { buildRequest, toApiError } from './client';

export class StreamInterruptedError extends Error {
  constructor() {
    super('stream ended before completion');
    this.name = 'StreamInterruptedError';
  }
}

/**
 * 生成APIはPOSTのため EventSource ではなく fetch + ReadableStream で受信する（§5.2）。
 * チャンク境界・UTF-8分割・ハートビート（コメント行）は共通のSSEパーサーで処理する。
 * done / error を受信せずに切断された場合は StreamInterruptedError を投げる。
 */
export async function streamChat(params: {
  chatId: string;
  requestId: string;
  content: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}): Promise<'done' | 'error'> {
  const init = await buildRequest('POST', { requestId: params.requestId, content: params.content });
  const res = await fetch(`/api/v1/chats/${encodeURIComponent(params.chatId)}/stream`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Accept: 'text/event-stream' },
    signal: params.signal,
  });
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new StreamInterruptedError();
  for await (const frame of readSseFrames(res.body, params.signal)) {
    const event = parseStreamEvent(frame);
    if (!event) continue;
    params.onEvent(event);
    if (event.event === 'done') return 'done';
    if (event.event === 'error') return 'error';
  }
  if (params.signal.aborted) throw new DOMException('aborted', 'AbortError');
  throw new StreamInterruptedError();
}
