import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../test/server';
import { ME, apiError, mockAuthenticated, mockChats, renderApp } from '../test/utils';
import { safeNext } from './LoginPage';

function mockStart(status = 202) {
  const calls: unknown[] = [];
  server.use(
    http.post('*/api/auth/otp/start', async ({ request }) => {
      calls.push(await request.json());
      return status === 202
        ? HttpResponse.json({ status: 'code_sent', message: 'ok', resendAfterSeconds: 60 }, { status: 202 })
        : HttpResponse.json(apiError('RATE_LIMITED', { retryAfter: '2026-10-29T03:01:00.000Z' }), { status });
    }),
  );
  return calls;
}

async function toCodeStep() {
  mockAuthenticated(null);
  const calls = mockStart();
  const r = renderApp('/login?next=%2Fsettings');
  await r.user.type(await screen.findByLabelText('メールアドレス'), 'user@example.com');
  await r.user.click(screen.getByRole('button', { name: 'コードを送信' }));
  await screen.findByLabelText('確認コード');
  return { ...r, calls };
}

describe('LoginPage', () => {
  it('sends a code and moves to the code step without revealing whether the account exists', async () => {
    const { calls } = await toCodeStep();
    expect(calls).toEqual([{ email: 'user@example.com' }]);
    expect(screen.getByRole('status')).toHaveTextContent('user@example.com に確認コードを送信しました');
    expect(screen.queryByText(/既に登録|見つかりません|新規ユーザー|ようこそ/)).toBeNull();
    expect(screen.getByRole('button', { name: 'コードを再送（60秒後）' })).toBeDisabled();
  });

  it('enables resend after the cooldown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { calls } = await toCodeStep();
      for (let i = 0; i < 61; i++) {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }
      const resend = await screen.findByRole('button', { name: 'コードを再送' });
      expect(resend).toBeEnabled();
      fireEvent.click(resend);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error for a wrong code and lets the user retry', async () => {
    const { user } = await toCodeStep();
    server.use(http.post('*/api/auth/otp/verify', () => HttpResponse.json(apiError('INVALID_CODE'), { status: 400 })));
    await user.type(screen.getByLabelText('確認コード'), '111111');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('確認コードが正しくありません');
    expect(screen.getByLabelText('確認コード')).toBeVisible();
  });

  it('returns to the email step when the flow expired', async () => {
    const { user } = await toCodeStep();
    server.use(http.post('*/api/auth/otp/verify', () => HttpResponse.json(apiError('AUTH_FLOW_EXPIRED'), { status: 400 })));
    await user.type(screen.getByLabelText('確認コード'), '111111');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('有効期限が切れました');
    expect(screen.getByLabelText('メールアドレス')).toBeVisible();
  });

  it('lets the user re-enter the email address', async () => {
    const { user } = await toCodeStep();
    await user.click(screen.getByRole('button', { name: 'メールアドレスを入力し直す' }));
    expect(screen.getByLabelText('メールアドレス')).toHaveValue('user@example.com');
  });

  it('accepts only digits and logs in, then follows the return path', async () => {
    const { user } = await toCodeStep();
    server.use(
      http.post('*/api/auth/otp/verify', () => {
        mockAuthenticated(ME);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mockChats();
    await user.type(screen.getByLabelText('確認コード'), '00a0000');
    expect(screen.getByLabelText('確認コード')).toHaveValue('000000');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(await screen.findByRole('heading', { name: '設定' })).toBeVisible();
  });

  it('shows the additional-code message when the server sends a sign-in code', async () => {
    const { user } = await toCodeStep();
    server.use(
      http.post('*/api/auth/otp/verify', () =>
        HttpResponse.json({ status: 'additional_code_sent', message: 'ログイン用のコードを送信しました' }, { status: 202 }),
      ),
    );
    await user.type(screen.getByLabelText('確認コード'), '123456');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(await screen.findByText('ログイン用のコードを送信しました')).toBeVisible();
    expect(screen.getByLabelText('確認コード')).toHaveValue('');
  });

  it('explains rate limiting with a JST time', async () => {
    mockAuthenticated(null);
    mockStart(429);
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('メールアドレス'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'コードを送信' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('10月29日 12:01（日本時間）以降に再度お試しください');
  });

  it('only allows same-site return paths', () => {
    expect(safeNext('/chat/abc')).toBe('/chat/abc');
    expect(safeNext('//evil.example')).toBe('/chat/new');
    expect(safeNext('/\\evil.example')).toBe('/chat/new');
    expect(safeNext('https://evil.example')).toBe('/chat/new');
    expect(safeNext(null)).toBe('/chat/new');
  });
});
