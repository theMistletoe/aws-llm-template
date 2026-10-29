import { describe, expect, it, vi } from 'vitest';
import { AgentCoreGatewaySearchProvider, WEB_SEARCH_TOOL, createSigV4Fetch, parseWebSearchResult } from './gateway-web-search';

describe('parseWebSearchResult', () => {
  it('parses the connector output (content[0].text JSON)', () => {
    const raw = {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: 'x',
            results: [
              { title: 'T', url: 'https://a.example', text: 'snippet', publishedDate: '2026-10-01' },
              { title: 'no url' },
            ],
          }),
        },
      ],
    };
    expect(parseWebSearchResult(raw)).toEqual([{ title: 'T', url: 'https://a.example', snippet: 'snippet', publishedDate: '2026-10-01' }]);
  });

  it('prefers structuredContent and handles errors / empty results', () => {
    expect(parseWebSearchResult({ structuredContent: { results: [{ url: 'https://b.example' }] } })).toEqual([
      { title: 'https://b.example', url: 'https://b.example', snippet: '' },
    ]);
    expect(parseWebSearchResult({ content: [] })).toEqual([]);
    expect(() => parseWebSearchResult({ isError: true })).toThrow();
  });

  it('only allows the WebSearch tool', () => {
    expect(WEB_SEARCH_TOOL.test('web-search___WebSearch')).toBe(true);
    expect(WEB_SEARCH_TOOL.test('WebSearch')).toBe(true);
    expect(WEB_SEARCH_TOOL.test('web-search___DeleteEverything')).toBe(false);
    expect(WEB_SEARCH_TOOL.test('x___WebSearchAdmin')).toBe(false);
  });
});

describe('createSigV4Fetch', () => {
  it('signs requests for the bedrock-agentcore service', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await createSigV4Fetch('ap-northeast-1')('https://gw.example.com/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0"}',
      });
      const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/bedrock-agentcore\/aws4_request/);
      expect(headers['x-amz-date']).toBeDefined();
      expect(headers).not.toHaveProperty('host');
      expect(init.body).toBe('{"jsonrpc":"2.0"}');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AgentCoreGatewaySearchProvider (fake MCP server)', () => {
  it('lists tools, ignores everything except WebSearch and calls it with the query', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const fakeFetch = (async (_input: string | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string; params?: Record<string, unknown> };
      calls.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}) });
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { headers: { 'content-type': 'application/json' } });
      switch (msg.method) {
        case 'initialize':
          return reply({ protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'gw', version: '1' } });
        case 'tools/list':
          return reply({
            tools: [
              { name: 'web-search___WebSearch', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
              { name: 'web-search___Evil', inputSchema: { type: 'object' } },
            ],
          });
        case 'tools/call':
          return reply({
            content: [{ type: 'text', text: JSON.stringify({ id: '1', results: [{ title: 'T', url: 'https://a.example', text: 's' }] }) }],
          });
        default:
          // 2025-11-25 までのサーバーは未知のメソッド（2026-07-28 の server/discover 等）に -32601 を返す
          if (msg.id !== undefined) {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }), {
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(null, { status: 202 });
      }
    }) as typeof fetch;
    const provider = new AgentCoreGatewaySearchProvider({ gatewayUrl: 'https://gw.example.com', region: 'ap-northeast-1', maxResults: 5, fetch: fakeFetch });
    const results = await provider.search('agentcore');
    expect(results).toEqual([{ title: 'T', url: 'https://a.example', snippet: 's' }]);
    const call = calls.find((c) => c.method === 'tools/call')!;
    expect(call.params).toMatchObject({ name: 'web-search___WebSearch', arguments: { query: 'agentcore', maxResults: 5 } });
    expect(calls.some((c) => c.method === 'tools/call' && c.params?.name === 'web-search___Evil')).toBe(false);
    expect(calls.map((c) => c.method)).toContain('initialize');
  });
});
