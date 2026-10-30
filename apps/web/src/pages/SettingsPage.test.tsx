import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import { mockAuthenticated, mockChats, renderApp } from '../test/utils';

describe('SettingsPage', () => {
  it('shows the email and logs out', async () => {
    mockAuthenticated();
    mockChats();
    let loggedOut = false;
    server.use(
      http.post('*/api/auth/logout', () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp('/settings');
    expect(await screen.findByText('user@example.com')).toBeVisible();
    expect(screen.queryByText('使用量')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'ログアウト' }));
    expect(await screen.findByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
    expect(loggedOut).toBe(true);
  });
});
