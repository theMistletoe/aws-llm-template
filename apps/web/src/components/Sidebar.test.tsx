import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import { apiError, chat, mockAuthenticated, mockChat, mockMessages, renderApp } from '../test/utils';

const A = '01JBQ7Z8X9Y0ABCDEFGHJKMNPA';
const B = '01JBQ7Z8X9Y0ABCDEFGHJKMNPB';

describe('Sidebar', () => {
  it('lists chats with paging', async () => {
    mockAuthenticated();
    server.use(
      http.get('*/api/v1/chats', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json(cursor ? { items: [chat(B, '二つ目')], nextCursor: null } : { items: [chat(A, '一つ目')], nextCursor: 'next' });
      }),
    );
    const { user } = renderApp('/chat/new');
    const nav = await screen.findByRole('navigation', { name: 'チャット一覧' });
    expect(await within(nav).findByRole('link', { name: '一つ目' })).toHaveAttribute('href', `/chat/${A}`);
    await user.click(within(nav).getByRole('button', { name: 'さらに表示' }));
    expect(await within(nav).findByRole('link', { name: '二つ目' })).toBeVisible();
  });

  it('renames and deletes chats with an inline confirmation', async () => {
    mockAuthenticated();
    let title = '元の名前';
    let deleted = false;
    server.use(
      http.get('*/api/v1/chats', () => HttpResponse.json({ items: deleted ? [] : [chat(A, title)], nextCursor: null })),
      http.patch(`*/api/v1/chats/${A}`, async ({ request }) => {
        title = ((await request.json()) as { title: string }).title;
        return HttpResponse.json(chat(A, title));
      }),
      http.delete(`*/api/v1/chats/${A}`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mockChat(chat(A, '元の名前'));
    mockMessages(A);
    const { user } = renderApp(`/chat/${A}`);
    await user.click(await screen.findByRole('button', { name: '「元の名前」の名前を変更' }));
    const input = screen.getByLabelText('新しいタイトル');
    await user.clear(input);
    await user.type(input, '新しい名前');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('link', { name: '新しい名前' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '「新しい名前」を削除' }));
    const dialog = screen.getByRole('alertdialog', { name: '削除の確認' });
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat/new'));
    expect(await screen.findByText('まだチャットはありません')).toBeVisible();
  });

  it('explains why a generating chat cannot be deleted', async () => {
    mockAuthenticated();
    server.use(
      http.get('*/api/v1/chats', () => HttpResponse.json({ items: [chat(A, '生成中')], nextCursor: null })),
      http.delete(`*/api/v1/chats/${A}`, () => HttpResponse.json(apiError('CHAT_BUSY'), { status: 409 })),
    );
    const { user } = renderApp('/chat/new');
    await user.click(await screen.findByRole('button', { name: '「生成中」を削除' }));
    await user.click(screen.getByRole('button', { name: '削除する' }));
    expect(await screen.findByText('生成中のチャットは削除できません。先に生成を停止してください。')).toBeVisible();
  });

  it('collapses on mobile behind a menu button', async () => {
    mockAuthenticated();
    server.use(http.get('*/api/v1/chats', () => HttpResponse.json({ items: [], nextCursor: null })));
    const { user } = renderApp('/chat/new');
    const toggle = await screen.findByRole('button', { name: 'メニュー' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
