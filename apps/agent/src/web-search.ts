import { isSafeHttpUrl } from '@ai-chat/contracts';

export type WebSource = { title: string; url: string; snippet: string; publishedDate?: string };

/** Web検索の差し替え境界（§6.6）。local: fixture / aws: AgentCore Gateway Web Search */
export interface WebSearchProvider {
  search(query: string, signal?: AbortSignal): Promise<readonly WebSource[]>;
}

export type SearchLimits = {
  maxResults: number;
  maxQueryLength: number;
  snippetMaxChars: number;
  timeoutMs: number;
  denyDomains: string[];
};

export function truncateChars(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}

function isDenied(url: string, denyDomains: string[]): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return denyDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 検索結果の検証: http/httpsのみ、拒否ドメイン除外、重複除外、件数・スニペット長の上限（§6.5, §8） */
export function sanitizeResults(results: readonly WebSource[], limits: SearchLimits, snippetChars = limits.snippetMaxChars): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const r of results) {
    if (typeof r.url !== 'string' || !isSafeHttpUrl(r.url) || isDenied(r.url, limits.denyDomains) || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      title: truncateChars(String(r.title ?? '').trim() || r.url, 200),
      url: r.url,
      snippet: truncateChars(String(r.snippet ?? '').trim(), snippetChars),
      ...(r.publishedDate ? { publishedDate: String(r.publishedDate).slice(0, 40) } : {}),
    });
    if (out.length >= limits.maxResults) break;
  }
  return out;
}

export class SearchTimeoutError extends Error {
  constructor() {
    super('search timed out');
    this.name = 'SearchTimeoutError';
  }
}

/** タイムアウトと呼び出し元の中断を両方効かせて検索する */
export async function searchWithTimeout(
  provider: WebSearchProvider,
  query: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<readonly WebSource[]> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return await new Promise<readonly WebSource[]>((resolve, reject) => {
    const onAbort = () => reject(timeout.aborted ? new SearchTimeoutError() : (signal?.reason ?? new Error('aborted')));
    if (combined.aborted) return onAbort();
    combined.addEventListener('abort', onAbort, { once: true });
    provider.search(query, combined).then(
      (r) => {
        combined.removeEventListener('abort', onAbort);
        resolve(r);
      },
      (e: unknown) => {
        combined.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
