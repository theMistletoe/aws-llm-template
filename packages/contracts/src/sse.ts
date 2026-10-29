import { streamEventSchemas, type StreamEvent, type StreamEventName } from './schemas';

/** SSEの1フレーム（コメント行は含まない） */
export type SseFrame = { event: string; data: string; id?: string };

/**
 * WHATWG仕様準拠のインクリメンタルSSEパーサー。
 * チャンク境界はイベント境界と一致しない前提で、行・フィールド単位でバッファする。
 * コメント行（`: ping` 等のハートビート）は無視する。
 */
export class SseParser {
  private buffer = '';
  private pendingCR = false;
  private eventName = '';
  private dataLines: string[] = [];
  private hasData = false;
  private lastId: string | undefined;

  feed(text: string): SseFrame[] {
    const frames: SseFrame[] = [];
    let input = text;
    if (this.pendingCR) {
      // 前チャンク末尾の \r と今回先頭の \n で1つの改行
      if (input.startsWith('\n')) input = input.slice(1);
      this.pendingCR = false;
    }
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.buffer + input.slice(start, i);
      this.buffer = '';
      if (ch === '\r') {
        if (i + 1 < input.length) {
          if (input[i + 1] === '\n') i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const frame = this.processLine(line);
      if (frame) frames.push(frame);
    }
    this.buffer += input.slice(start);
    return frames;
  }

  /** ストリーム終端。仕様上、終端の未完了イベントは破棄する */
  end(): SseFrame[] {
    this.buffer = '';
    this.resetEvent();
    return [];
  }

  private processLine(line: string): SseFrame | undefined {
    if (line === '') {
      if (!this.hasData) {
        this.resetEvent();
        return undefined;
      }
      const frame: SseFrame = {
        event: this.eventName || 'message',
        data: this.dataLines.join('\n'),
        ...(this.lastId !== undefined ? { id: this.lastId } : {}),
      };
      this.resetEvent();
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastId = value;
        break;
      default:
        break;
    }
    return undefined;
  }

  private resetEvent(): void {
    this.eventName = '';
    this.dataLines = [];
    this.hasData = false;
  }
}

/** ReadableStream<Uint8Array> をSSEフレームの非同期反復に変換する（UTF-8のマルチバイト分割に対応） */
export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) yield* parser.feed(tail);
        parser.end();
        return;
      }
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // 後始末の失敗はストリームの結果に影響させない
    }
  }
}

/** SSEフレームを §5.2 のイベントとして検証する。未知・不正なイベントは null */
export function parseStreamEvent(frame: SseFrame): StreamEvent | null {
  if (!(frame.event in streamEventSchemas)) return null;
  const name = frame.event as StreamEventName;
  let json: unknown;
  try {
    json = JSON.parse(frame.data);
  } catch {
    return null;
  }
  const result = streamEventSchemas[name].safeParse(json);
  if (!result.success) return null;
  return { event: name, data: result.data } as StreamEvent;
}

export function formatSseEvent(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

export const SSE_HEARTBEAT = ': ping\n\n';
