import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { McpClient } from '@strands-agents/sdk';
import { z } from 'zod';
import type { WebSearchProvider, WebSource } from './web-search';

/**
 * Gatewayが公開するツール名は `<target>___WebSearch`。これ以外のツールは検出しても使わない（§6.5）。
 * StrandsのMCPツールフィルタはRegExpを先頭アンカーで評価するため、先頭からマッチする形にする。
 */
export const WEB_SEARCH_TOOL = /^(?:[A-Za-z0-9-]+___)?WebSearch$/;

const resultSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        text: z.string().optional(),
        publishedDate: z.string().optional(),
      }),
    )
    .default([]),
});

/** MCP tools/call の結果（content[0].text にJSON文字列）を検索結果に変換する */
export function parseWebSearchResult(raw: unknown): WebSource[] {
  const result = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  if (result?.isError) throw new Error('web search tool returned an error');
  let payload: unknown = result?.structuredContent;
  if (!payload) {
    const text = result?.content?.find((c) => c.type === 'text')?.text;
    if (!text) return [];
    payload = JSON.parse(text);
  }
  return resultSchema.parse(payload).results.flatMap((r) =>
    r.url
      ? [{ title: r.title ?? r.url, url: r.url, snippet: r.text ?? '', ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}) }]
      : [],
  );
}

/** SigV4（service: bedrock-agentcore）で署名するfetch。Gatewayのinbound認証はAWS_IAM */
export function createSigV4Fetch(region: string): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials: fromNodeProviderChain(), sha256: Sha256 });
  return async (input, init = {}) => {
    const url = new URL(input.toString());
    const headers: Record<string, string> = { host: url.host };
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === 'string' ? init.body : undefined;
    const query = Object.fromEntries(url.searchParams);
    const signed = await signer.sign(
      new HttpRequest({
        method: (init.method ?? 'GET').toUpperCase(),
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        headers,
        ...(body !== undefined ? { body } : {}),
      }),
    );
    const { host: _host, ...sendHeaders } = signed.headers;
    return fetch(url, { ...init, headers: sendHeaders, ...(body !== undefined ? { body } : {}) });
  };
}

/**
 * 本番用: AgentCore Gateway（MCP, inbound AWS_IAM）の Web Search connector を、
 * StrandsのMCPクライアント経由で呼ぶ。ステートレス規約のため検索ごとに接続し、終了時に切断する。
 */
export class AgentCoreGatewaySearchProvider implements WebSearchProvider {
  constructor(
    private readonly options: { gatewayUrl: string; region: string; maxResults: number; fetch?: typeof fetch },
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly WebSource[]> {
    const raw = this.options.gatewayUrl.replace(/\/+$/, '');
    const url = new URL(raw.endsWith('/mcp') ? raw : `${raw}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: this.options.fetch ?? createSigV4Fetch(this.options.region),
    });
    const mcp = new McpClient({ transport, toolFilters: { allowed: [WEB_SEARCH_TOOL] } });
    const onAbort = () => void mcp.disconnect().catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const tools = await mcp.listTools();
      const tool = tools.find((t) => WEB_SEARCH_TOOL.test(t.name));
      if (!tool) throw new Error('WebSearch tool not found on the gateway');
      const result = await mcp.callTool(tool, { query, maxResults: this.options.maxResults });
      if (signal?.aborted) throw signal.reason;
      return parseWebSearchResult(result);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await mcp.disconnect().catch(() => undefined);
    }
  }
}
