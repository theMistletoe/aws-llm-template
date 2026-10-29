import { SseParser, parseStreamEvent, type StreamEvent } from '@ai-chat/contracts';

/** SSEレスポンスを最後まで読み、イベントと生テキストを返す */
export async function readSse(res: Response): Promise<{ events: StreamEvent[]; raw: string }> {
  const raw = await res.text();
  const parser = new SseParser();
  const events = parser
    .feed(raw)
    .map(parseStreamEvent)
    .filter((e): e is StreamEvent => e !== null);
  return { events, raw };
}
