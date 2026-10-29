import type { MessageList } from '@ai-chat/contracts';
import { describe, expect, it } from 'vitest';
import { LIMITED_API } from './env';
import { Client, readSse } from './helpers';

describe('web search citations (fixture search)', () => {
  it('streams tool status and source events and stores citations', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const { events } = await readSse(await c.stream(chat.id, '最新のAWSニュースを検索して'));
    const tool = events.filter((e) => e.event === 'tool_status').map((e) => (e.data as { status: string }).status);
    expect(tool).toEqual(['running', 'done']);
    const sources = events.filter((e) => e.event === 'source').map((e) => e.data as { url: string; publishedDate?: string });
    expect(sources.length).toBe(2);
    expect(sources[0]!.url).toMatch(/^https:\/\/docs\.aws\.amazon\.com\//);
    expect(sources[0]!.publishedDate).toBe('2026-10-01');
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.at(-1)!.citations).toHaveLength(2);
  });

  it('drops unsafe URLs from malicious search results and never exposes tool internals', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const { events, raw } = await readSse(await c.stream(chat.id, 'injection の最新情報を検索'));
    const urls = events.filter((e) => e.event === 'source').map((e) => (e.data as { url: string }).url);
    expect(urls).toEqual(['https://example.com/prompt-injection']);
    expect(raw).not.toContain('javascript:');
    expect(raw).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(raw).not.toContain('"query"');
    expect(events.at(-1)!.event).toBe('done');
  });

  it('reports search failures and marks the answer as unverified', async () => {
    const c = new Client();
    await c.login();
    const chat = await c.createChat();
    const { events } = await readSse(await c.stream(chat.id, '最新ニュース [[search_fail]]'));
    expect(events.filter((e) => e.event === 'tool_status').map((e) => (e.data as { status: string }).status)).toEqual([
      'running',
      'failed',
    ]);
    const list = (await (await c.get(`/api/v1/chats/${chat.id}/messages`)).json()) as MessageList;
    expect(list.items.at(-1)).toMatchObject({ searchFailed: true, status: 'completed' });
    expect(list.items.at(-1)!.content).toContain('未確認');
  });

  it('stops offering web search after the daily search quota', async () => {
    const c = new Client(LIMITED_API);
    await c.login();
    const chat = await c.createChat();
    const first = await readSse(await c.stream(chat.id, '最新のAWSニュース'));
    expect(first.events.some((e) => e.event === 'tool_status')).toBe(true);
    const second = await readSse(await c.stream(chat.id, '最新のAWSニュース 2'));
    expect(second.events.some((e) => e.event === 'tool_status')).toBe(false);
    expect(second.events.at(-1)!.event).toBe('done');
  });
});
