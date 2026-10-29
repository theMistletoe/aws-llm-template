import type { Chat, ChatMessage, Me } from '@ai-chat/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App';
import { server } from './server';

export const ME: Me = { sub: 'user-1', email: 'user@example.com' };

export function LocationProbe() {
  const location = useLocation();
  return (
    <div hidden data-testid="location">
      {`${location.pathname}${location.search}`}
    </div>
  );
}

export function renderApp(path: string): RenderResult & { user: UserEvent; queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, user, queryClient };
}

export const chat = (id: string, title = 'テストチャット'): Chat => ({
  id,
  title,
  createdAt: '2026-10-29T03:00:00.000Z',
  updatedAt: '2026-10-29T03:00:00.000Z',
});

export const message = (partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage => ({
  chatId: 'C1',
  status: 'completed',
  createdAt: '2026-10-29T03:00:00.000Z',
  ...partial,
});

export function mockAuthenticated(me: Me | null = ME) {
  server.use(http.get('*/api/auth/me', () => (me ? HttpResponse.json(me) : HttpResponse.json(apiError('UNAUTHENTICATED'), { status: 401 }))));
}

export function apiError(code: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message: `${code} message`, requestId: 'req', retryable: false, ...extra } };
}

export function mockChats(chats: Chat[] = []) {
  server.use(http.get('*/api/v1/chats', () => HttpResponse.json({ items: chats, nextCursor: null })));
}

export function mockMessages(chatId: string, items: ChatMessage[] = []) {
  server.use(http.get(`*/api/v1/chats/${chatId}/messages`, () => HttpResponse.json({ items, nextCursor: null })));
}

export function mockChat(c: Chat) {
  server.use(http.get(`*/api/v1/chats/${c.id}`, () => HttpResponse.json(c)));
}

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** チャンク境界を任意の位置で区切ってSSEを返すストリーム */
export function sseStream(chunks: string[], options: { holdOpen?: boolean; gapMs?: number } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (options.gapMs) await delay(options.gapMs);
        controller.enqueue(encoder.encode(c));
      }
      if (!options.holdOpen) controller.close();
    },
  });
}

export function sseResponse(stream: ReadableStream<Uint8Array>) {
  return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
