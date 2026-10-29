import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SseParser, parseStreamEvent, type Chat, type StreamEvent } from '@ai-chat/contracts';
import { DEV_AUTH_CODE, uniqueEmail } from '@ai-chat/test-fixtures';
import { uuidv7 } from 'uuidv7';
import { API, ORIGIN } from './env';

export const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: 'ap-northeast-1',
    endpoint: 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);

/** Cookieを保持する実HTTPクライアント（ケースごとに独立ユーザー） */
export class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly base = API) {}

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers.Origin = ORIGIN;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookies.size > 0) headers.Cookie = this.cookieHeader();
    Object.assign(headers, extra);
    for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (/max-age=0/i.test(c) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get = (path: string, extra?: Record<string, string>) => this.request('GET', path, undefined, extra);
  post = (path: string, body: unknown = {}, extra?: Record<string, string>) => this.request('POST', path, body, extra);
  patch = (path: string, body: unknown) => this.request('PATCH', path, body);
  del = (path: string) => this.request('DELETE', path);

  async login(email = uniqueEmail()): Promise<string> {
    const s = await this.post('/api/auth/otp/start', { email });
    if (s.status !== 202) throw new Error(`otp/start ${s.status}`);
    const v = await this.post('/api/auth/otp/verify', { code: DEV_AUTH_CODE });
    if (v.status !== 204) throw new Error(`otp/verify ${v.status}`);
    return email;
  }

  async createChat(): Promise<Chat> {
    return (await (await this.post('/api/v1/chats', {})).json()) as Chat;
  }

  stream(chatId: string, content: string, requestId = uuidv7(), signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}/api/v1/chats/${chatId}/stream`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: this.cookieHeader() },
      body: JSON.stringify({ requestId, content }),
      ...(signal ? { signal } : {}),
    });
  }
}

export async function readSse(res: Response): Promise<{ events: StreamEvent[]; raw: string }> {
  const raw = await res.text();
  const events = new SseParser()
    .feed(raw)
    .map(parseStreamEvent)
    .filter((e): e is StreamEvent => e !== null);
  return { events, raw };
}

export async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}
