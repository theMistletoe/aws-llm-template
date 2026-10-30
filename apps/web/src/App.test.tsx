import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from './test/server';
import { mockAuthenticated, mockChats, renderApp } from './test/utils';

describe('routing and authentication guard', () => {
  it('sends unauthenticated visitors from / to the login screen', async () => {
    mockAuthenticated(null);
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('sends signed-in users from / to a new chat', async () => {
    mockAuthenticated();
    mockChats();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '新しいチャット' })).toBeVisible();
  });

  it('redirects protected pages to login with a return path', async () => {
    mockAuthenticated(null);
    renderApp('/chat/01JBQ7Z8X9Y0ABCDEFGHJKMNPQ');
    expect(await screen.findByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/login?next=%2Fchat%2F01JBQ7Z8X9Y0ABCDEFGHJKMNPQ');
  });

  it('shows a retry when /auth/me fails', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({}, { status: 500 })));
    const { user } = renderApp('/settings');
    expect(await screen.findByRole('alert')).toHaveTextContent('サーバーに接続できませんでした');
    mockAuthenticated();
    mockChats();
    await user.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByRole('heading', { name: '設定' })).toBeVisible();
  });

  it('renders error pages', async () => {
    mockAuthenticated(null);
    renderApp('/error?code=403');
    expect(screen.getByRole('heading', { name: 'アクセスが拒否されました' })).toBeVisible();
  });

  it('renders 404 for unknown routes', () => {
    renderApp('/nope');
    expect(screen.getByRole('heading', { name: 'ページが見つかりません' })).toBeVisible();
  });

  it('shows the error page when / cannot reach the server', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({}, { status: 503 })));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'エラーが発生しました' })).toBeVisible();
  });
});
