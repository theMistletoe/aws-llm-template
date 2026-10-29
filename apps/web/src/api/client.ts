import { apiErrorSchema, type ApiError } from '@ai-chat/contracts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfter: string | undefined;
  readonly requestId: string | undefined;

  constructor(status: number, body: ApiError['error'] | undefined) {
    super(body?.message ?? `HTTP ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.code ?? (status === 0 ? 'NETWORK_ERROR' : 'HTTP_ERROR');
    this.retryable = body?.retryable ?? status >= 500;
    this.retryAfter = body?.retryAfter;
    this.requestId = body?.requestId;
  }
}

/** 401を受けたときに通知する（App側でログイン画面へ誘導する） */
export const UNAUTHENTICATED_EVENT = 'app:unauthenticated';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildRequest(method: string, body?: unknown): Promise<RequestInit> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    // Lambda Function URL + CloudFront OAC では POST/PUT のボディハッシュが必要（§9.4 代替構成）
    if (import.meta.env.VITE_PAYLOAD_HASH_HEADER === 'true') headers['x-amz-content-sha256'] = await sha256Hex(payload);
  }
  return { method, headers, credentials: 'same-origin', ...(payload !== undefined ? { body: payload } : {}) };
}

export async function toApiError(res: Response): Promise<ApiRequestError> {
  let body: ApiError['error'] | undefined;
  try {
    const parsed = apiErrorSchema.safeParse(await res.json());
    if (parsed.success) body = parsed.data.error;
  } catch {
    body = undefined;
  }
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  return new ApiRequestError(res.status, body);
}

export async function apiFetch<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const init = await buildRequest(options.method ?? 'GET', options.body);
  let res: Response;
  try {
    res = await fetch(path, { ...init, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(0, undefined);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
