import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import { mockAuthenticated, mockChats, renderApp } from '../test/utils';

describe('SettingsPage', () => {
  it('shows the email, usage and logs out', async () => {
    mockAuthenticated();
    mockChats();
    let loggedOut = false;
    server.use(
      http.get('*/api/v1/usage', () =>
        HttpResponse.json({
          timeZone: 'Asia/Tokyo',
          daily: { date: '2026-10-29', requests: 3, requestLimit: 20, searches: 1, searchLimit: 20, resetsAt: '2026-10-29T15:00:00.000Z' },
          hourly: { hour: '2026-10-29T12', requests: 2, requestLimit: 10, resetsAt: '2026-10-29T04:00:00.000Z' },
        }),
      ),
      http.post('*/api/auth/logout', () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp('/settings');
    expect(await screen.findByText('user@example.com')).toBeVisible();
    expect(await screen.findByText('3 / 20')).toBeVisible();
    expect(screen.getByText('2 / 10')).toBeVisible();
    expect(screen.getByText('1 / 20')).toBeVisible();
    expect(screen.getByText('10月30日 0:00（日本時間）')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'ログアウト' }));
    expect(await screen.findByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
    expect(loggedOut).toBe(true);
  });
});
