import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login, sendMessage } from './helpers';

test('ユーザーがチャットで質問し、回答の逐次表示・タイトル自動設定・リロード後の復元・削除・ログアウトができる', async ({
  app,
  screen,
  browser,
}) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await expect(screen.getByRole('heading', { name: /チャット/ })).toBeVisible();

  await sendMessage(screen, 'こんにちは、自己紹介して');
  await expect(browser).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
  await expect(screen.getByText(/ローカル固定モデルの応答です。「こんにちは、自己紹介して」/)).toBeVisible();
  await expect(screen.getByRole('button', { name: '送信' })).toBeVisible();

  const nav = screen.getByRole('navigation', { name: 'チャット一覧' });
  await expect(nav.getByRole('link', { name: 'こんにちは、自己紹介して' })).toBeVisible();

  await browser.reload();
  await expect(screen.getByRole('heading', { name: 'こんにちは、自己紹介して' })).toBeVisible();
  await expect(screen.getByText('こんにちは、自己紹介して', { exact: true }).first()).toBeVisible();
  await expect(screen.getByText(/ローカル固定モデルの応答です/)).toBeVisible();

  await nav.getByRole('button', { name: '「こんにちは、自己紹介して」を削除' }).click();
  await screen.getByRole('button', { name: '削除する' }).click();
  await expect(browser).toHaveURL('/chat/new');
  await expect(nav.getByText('まだチャットはありません')).toBeVisible();

  await nav.getByRole('link', { name: '設定' }).click();
  await screen.getByRole('button', { name: 'ログアウト' }).click();
  await expect(screen.getByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
});

test('他人のチャットは存在しないものとして扱われる', async ({ app, screen, browser }) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, '私だけのチャット');
  await expect(screen.getByText(/ローカル固定モデルの応答です/)).toBeVisible();
  const ownerUrl = await browser.url();
  await app.open('/settings');
  await screen.getByRole('button', { name: 'ログアウト' }).click();

  await login(app, screen);
  await app.open(new URL(ownerUrl).pathname);
  await expect(screen.getByRole('heading', { name: 'チャットが見つかりません' })).toBeVisible();
});

test('生成を停止すると中断として記録され、リロード後も中断と表示される', async ({ app, screen, browser }) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, '[[slow]] 長い回答をください');
  await screen.getByRole('button', { name: '生成を停止' }).click();
  await expect(screen.getByText('中断されました')).toBeVisible();
  await browser.reload();
  await expect(screen.getByText('中断されました')).toBeVisible();
  await expect(screen.getByRole('button', { name: '再送' })).toBeVisible();
});

test('XSSを含む入力・出力はスクリプトとして実行されず、危険なリンクも作られない', async ({ app, screen }) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  // ダイアログが出た場合は未処理として次のステップが失敗する
  await sendMessage(screen, `<script>alert('xss')</script> [[markdown]]`);
  await expect(screen.getByText(`<script>alert('xss')</script> [[markdown]]`)).toBeVisible();
  await expect(screen.getByRole('heading', { name: '見出し' })).toBeVisible();
  await expect(screen.getByRole('link', { name: '安全なリンク' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(screen.getByRole('link', { name: '安全なリンク' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(screen.getByRole('link', { name: '危険なリンク' })).toHaveCount(0);
  await expect(screen.getByText('<b>escaped</b>')).toBeVisible();
});

test('生成中のチャット（409）への送信は案内を表示し、入力内容を残す', async ({ app, screen, browser }) => {
  await browser.route('**/api/v1/chats/*/stream', async (route) => {
    await route.fulfill({
      status: 409,
      json: { error: { code: 'CHAT_BUSY', message: '応答を生成中です', requestId: 'x', retryable: true } },
    });
  });
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, 'もう一度');
  await expect(screen.getByRole('alert')).toContainText('このチャットは応答を生成中です。');
  await expect(screen.getByLabel('メッセージ')).toHaveValue('もう一度');
});

test('API切断時は状態の確認を促し、5xxでも画面が壊れない', async ({ app, screen, browser }) => {
  await browser.route('**/api/v1/chats/*/stream', async (route) => {
    await route.abort();
  });
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, '切断される質問');
  await expect(screen.getByRole('alert')).toContainText('通信が切断されました');
  await browser.unroute('**/api/v1/chats/*/stream');
  await browser.route('**/api/v1/chats/*/stream', async (route) => {
    await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました', requestId: 'x', retryable: true } } });
  });
  await screen.getByRole('button', { name: '閉じる' }).click();
  await sendMessage(screen, '5xxになる質問');
  await expect(screen.getByRole('alert')).toContainText('サーバーエラーが発生しました');
  await expect(screen.getByRole('button', { name: '再送' })).toBeVisible();
});

test('重複・順序違いのイベントでも出典は重複せず、完了後に表示が確定する', async ({ app, screen, browser }) => {
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await browser.route('**/api/v1/chats/*/stream', async (route) => {
    const chatId = new URL(route.request.url).pathname.split('/')[4];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body:
        sse('start', { requestId: 'r', chatId, userMessageId: 'U-mock', assistantMessageId: 'A-mock' }) +
        sse('source', { title: '重複する出典', url: 'https://example.com/dup' }) +
        ': ping\n\n' +
        sse('delta', { text: 'モック応答' }) +
        sse('source', { title: '重複する出典', url: 'https://example.com/dup' }) +
        sse('done', { messageId: 'A-mock', finishReason: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }),
    });
  });
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, 'モックされた質問');
  await expect(screen.getByText('モック応答')).toBeVisible();
  await expect(screen.getByRole('link', { name: '重複する出典' })).toHaveCount(1);
});
