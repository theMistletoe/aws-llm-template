import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureWebSearchProvider } from './mock-web-search';
import { SearchTimeoutError, sanitizeResults, searchWithTimeout, truncateChars } from './web-search';

const fixturesDir = fileURLToPath(new URL('../../../local/fixtures/search', import.meta.url));
const limits = { maxResults: 2, maxQueryLength: 200, snippetMaxChars: 10, timeoutMs: 100, denyDomains: ['bad.example'] };

describe('sanitizeResults', () => {
  it('keeps only safe, allowed, unique results within limits', () => {
    const out = sanitizeResults(
      [
        { title: '', url: 'https://a.example/1', snippet: '0123456789abcdef', publishedDate: '2026-01-01' },
        { title: 'x', url: 'ftp://a.example/2', snippet: '' },
        { title: 'x', url: 'https://www.bad.example/3', snippet: '' },
        { title: 'x', url: 'https://a.example/1', snippet: '' },
        { title: 'B', url: 'http://b.example/', snippet: 's' },
        { title: 'C', url: 'https://c.example/', snippet: 's' },
      ],
      limits,
    );
    expect(out).toEqual([
      { title: 'https://a.example/1', url: 'https://a.example/1', snippet: '0123456789…', publishedDate: '2026-01-01' },
      { title: 'B', url: 'http://b.example/', snippet: 's' },
    ]);
  });

  it('truncates by code points', () => {
    expect(truncateChars('🙂🙂🙂', 2)).toBe('🙂🙂…');
    expect(truncateChars('ab', 2)).toBe('ab');
  });
});

describe('searchWithTimeout', () => {
  it('rejects with SearchTimeoutError when the provider is too slow', async () => {
    await expect(searchWithTimeout({ search: () => new Promise(() => undefined) }, 'q', 20)).rejects.toBeInstanceOf(SearchTimeoutError);
  });

  it('propagates caller aborts and provider errors', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(searchWithTimeout({ search: () => new Promise(() => undefined) }, 'q', 1000, ac.signal)).rejects.toThrow('stop');
    await expect(searchWithTimeout({ search: async () => { throw new Error('boom'); } }, 'q', 1000)).rejects.toThrow('boom');
  });
});

describe('FixtureWebSearchProvider', () => {
  const provider = new FixtureWebSearchProvider(fixturesDir);

  it('matches fixtures by keyword and falls back to the default', async () => {
    expect((await provider.search('AWSの最新情報'))[0]!.url).toContain('docs.aws.amazon.com');
    expect((await provider.search('天気'))[0]!.url).toBe('https://example.com/news/local-fixture');
  });

  it('can simulate failures and includes a malicious fixture for injection tests', async () => {
    await expect(provider.search('[[search_fail]]')).rejects.toThrow();
    const injected = await provider.search('injection');
    expect(injected.some((r) => r.url.startsWith('javascript:'))).toBe(true);
  });
});
