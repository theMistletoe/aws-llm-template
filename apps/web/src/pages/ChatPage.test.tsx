import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import {
  apiError,
  chat,
  message,
  mockAuthenticated,
  mockChat,
  mockChats,
  mockMessages,
  renderApp,
  sse,
  sseResponse,
  sseStream,
} from '../test/utils';

const CHAT_ID = '01JBQ7Z8X9Y0ABCDEFGHJKMNPQ';
const start = { requestId: 'r', chatId: CHAT_ID, userMessageId: 'U1', assistantMessageId: 'A1' };
const done = { messageId: 'A1', finishReason: 'complete', usage: { inputTokens: 1, outputTokens: 2 } };

function setupNewChat() {
  mockAuthenticated();
  mockChats();
  mockChat(chat(CHAT_ID, '新しいチャット'));
  mockMessages(CHAT_ID);
  const created: unknown[] = [];
  server.use(
    http.post('*/api/v1/chats', async ({ request }) => {
      created.push(await request.json());
      return HttpResponse.json(chat(CHAT_ID, '新しいチャット'), { status: 201 });
    }),
  );
  return created;
}

describe('ChatPage', () => {
  it('creates a chat on first send and streams the answer with web search status and citations', async () => {
    const created = setupNewChat();
    let streamBody: unknown;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(`*/api/v1/chats/${CHAT_ID}/stream`, async ({ request }) => {
        streamBody = await request.json();
        const first = sse('start', start) + sse('tool_status', { tool: 'web_search', status: 'running' });
        const encoder = new TextEncoder();
        const rest =
          ': ping\n\n' +
          sse('tool_status', { tool: 'web_search', status: 'done' }) +
          sse('source', { title: 'AWS Docs', url: 'https://docs.aws.amazon.com/x', publishedDate: '2026-10-01' }) +
          sse('delta', { text: 'こんにちは' }) +
          sse('delta', { text: '、世界' }) +
          sse('done', done);
        const bytes = encoder.encode(rest);
        return sseResponse(
          new ReadableStream({
            async start(c) {
              c.enqueue(encoder.encode(first));
              await gate;
              // UTF-8のマルチバイト文字の途中でチャンクを分割する
              for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
              c.close();
            },
          }),
        );
      }),
    );
    const { user } = renderApp('/chat/new');
    await user.type(await screen.findByLabelText('メッセージ'), '最新のAWSニュース');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Webを検索中…')).toBeVisible();
    expect(screen.getByRole('button', { name: '生成を停止' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '送信' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${CHAT_ID}`);
    release();
    expect(await screen.findByText('こんにちは、世界')).toBeVisible();
    expect(screen.queryByText('Webを検索中…')).toBeNull();
    const sources = screen.getByRole('region', { name: '出典' });
    const link = within(sources).getByRole('link', { name: 'AWS Docs' });
    expect(link).toHaveAttribute('href', 'https://docs.aws.amazon.com/x');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(sources).getByText('公開日: 2026-10-01')).toBeVisible();
    expect(created).toEqual([{}]);
    expect(streamBody).toMatchObject({ content: '最新のAWSニュース' });
    expect((streamBody as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.getByRole('button', { name: '送信' })).toBeVisible());
  });

  it('prevents double submission and stops generation with AbortController', async () => {
    setupNewChat();
    let requests = 0;
    server.use(
      http.post(`*/api/v1/chats/${CHAT_ID}/stream`, () => {
        requests++;
        return sseResponse(sseStream([sse('start', start), sse('delta', { text: '途中まで' })], { holdOpen: true }));
      }),
    );
    const { user } = renderApp(`/chat/new`);
    const box = await screen.findByLabelText('メッセージ');
    await user.type(box, '長い質問');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('途中まで')).toBeVisible();
    await user.type(box, '割り込み');
    await user.keyboard('{Enter}');
    expect(requests).toBe(1);
    await user.click(screen.getByRole('button', { name: '生成を停止' }));
    expect(await screen.findByText('中断されました')).toBeVisible();
    expect(await screen.findByRole('button', { name: '送信' })).toBeVisible();
  });

  it('shows a retryable error banner when the chat is busy and keeps the draft', async () => {
    mockAuthenticated();
    mockChats([chat(CHAT_ID)]);
    mockChat(chat(CHAT_ID));
    mockMessages(CHAT_ID, [message({ id: 'M0', role: 'user', content: '前の質問' })]);
    server.use(
      http.post(`*/api/v1/chats/${CHAT_ID}/stream`, () =>
        HttpResponse.json(apiError('CHAT_BUSY', { retryable: true }), { status: 409 }),
      ),
    );
    const { user } = renderApp(`/chat/${CHAT_ID}`);
    await user.type(await screen.findByLabelText('メッセージ'), 'もう一回');
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('このチャットは応答を生成中です。完了するか停止してから送信してください。');
    expect(screen.getByRole('button', { name: '再送' })).toBeVisible();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('もう一回');
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows stream errors and allows resending a failed answer', async () => {
    mockAuthenticated();
    mockChats([chat(CHAT_ID)]);
    mockChat(chat(CHAT_ID));
    mockMessages(CHAT_ID, [
      message({ id: 'M0', role: 'user', content: '質問A' }),
      message({ id: 'M1', role: 'assistant', content: '', status: 'failed' }),
    ]);
    const bodies: Array<{ content: string }> = [];
    server.use(
      http.post(`*/api/v1/chats/${CHAT_ID}/stream`, async ({ request }) => {
        bodies.push((await request.json()) as { content: string });
        return sseResponse(
          sseStream([sse('start', start), sse('error', { code: 'MODEL_TIMEOUT', message: 'timeout', retryable: true })]),
        );
      }),
    );
    const { user } = renderApp(`/chat/${CHAT_ID}`);
    expect(await screen.findByText('応答に失敗しました')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '再送' }));
    expect(await screen.findByText('応答がタイムアウトしました。再送してください。')).toBeVisible();
    expect(bodies).toEqual([expect.objectContaining({ content: '質問A' })]);
  });

  it('restores the conversation after reload, including interrupted answers', async () => {
    mockAuthenticated();
    mockChats([chat(CHAT_ID, '旅行の相談')]);
    mockChat(chat(CHAT_ID, '旅行の相談'));
    mockMessages(CHAT_ID, [
      message({ id: 'M0', role: 'user', content: '京都のおすすめは？' }),
      message({ id: 'M1', role: 'assistant', content: '途中までの回答', status: 'interrupted' }),
    ]);
    renderApp(`/chat/${CHAT_ID}`);
    expect(await screen.findByRole('heading', { name: '旅行の相談' })).toBeVisible();
    expect(screen.getByText('京都のおすすめは？')).toBeVisible();
    expect(screen.getByText('中断されました')).toBeVisible();
    expect(screen.getByRole('button', { name: '再送' })).toBeVisible();
  });

  it('pages older messages', async () => {
    mockAuthenticated();
    mockChats([chat(CHAT_ID)]);
    mockChat(chat(CHAT_ID));
    server.use(
      http.get(`*/api/v1/chats/${CHAT_ID}/messages`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json(
          cursor
            ? { items: [message({ id: 'OLD', role: 'user', content: '古いメッセージ' })], nextCursor: null }
            : { items: [message({ id: 'NEW', role: 'user', content: '新しいメッセージ' })], nextCursor: 'c1' },
        );
      }),
    );
    const { user } = renderApp(`/chat/${CHAT_ID}`);
    await user.click(await screen.findByRole('button', { name: '以前のメッセージを読み込む' }));
    expect(await screen.findByText('古いメッセージ')).toBeVisible();
    const texts = screen.getAllByRole('article').map((a) => a.textContent);
    expect(texts[0]).toContain('古いメッセージ');
    expect(texts[1]).toContain('新しいメッセージ');
    expect(screen.queryByRole('button', { name: '以前のメッセージを読み込む' })).toBeNull();
  });

  it('shows a not-found state for chats that do not exist or belong to others', async () => {
    mockAuthenticated();
    mockChats();
    server.use(
      http.get(`*/api/v1/chats/${CHAT_ID}`, () => HttpResponse.json(apiError('NOT_FOUND'), { status: 404 })),
      http.get(`*/api/v1/chats/${CHAT_ID}/messages`, () => HttpResponse.json(apiError('NOT_FOUND'), { status: 404 })),
    );
    renderApp(`/chat/${CHAT_ID}`);
    expect(await screen.findByRole('heading', { name: 'チャットが見つかりません' })).toBeVisible();
  });

  it('marks failed web searches as unverified', async () => {
    mockAuthenticated();
    mockChats([chat(CHAT_ID)]);
    mockChat(chat(CHAT_ID));
    mockMessages(CHAT_ID, [message({ id: 'M1', role: 'assistant', content: '回答', searchFailed: true })]);
    renderApp(`/chat/${CHAT_ID}`);
    expect(await screen.findByText(/Web検索に失敗したため/)).toBeVisible();
  });

  it('treats a dropped connection as interrupted and re-checks the server', async () => {
    setupNewChat();
    let messageFetches = 0;
    server.use(
      http.get(`*/api/v1/chats/${CHAT_ID}/messages`, () => {
        messageFetches++;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.post(`*/api/v1/chats/${CHAT_ID}/stream`, () => sseResponse(sseStream([sse('start', start), sse('delta', { text: '途' })], { gapMs: 100 }))),
    );
    const { user } = renderApp('/chat/new');
    await user.type(await screen.findByLabelText('メッセージ'), 'q');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('通信が切断されました。応答の状態を確認しています。')).toBeVisible();
    await waitFor(() => expect(messageFetches).toBeGreaterThanOrEqual(2));
  });
});
