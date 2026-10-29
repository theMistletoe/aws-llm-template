import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { DEV_CODE, login, uniqueEmail } from './helpers';

test('未認証で保護ページを開くとログイン画面へ誘導され、ログイン後に元のページへ戻る', async ({ app, screen, browser }) => {
  await app.open('/settings');
  await expect(screen.getByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
  await expect(browser).toHaveURL('/login?next=%2Fsettings');
  const email = uniqueEmail('auth');
  await screen.getByLabel('メールアドレス').fill(email);
  await screen.getByRole('button', { name: 'コードを送信' }).click();
  await screen.getByLabel('確認コード').fill(DEV_CODE);
  await screen.getByRole('button', { name: 'ログイン' }).click();
  await expect(screen.getByRole('heading', { name: '設定' })).toBeVisible();
  await expect(screen.getByText(email)).toBeVisible();
});

test('誤ったコードではログインできず、メールアドレスの入力し直しもできる', async ({ app, screen }) => {
  await app.open('/login');
  await screen.getByLabel('メールアドレス').fill(uniqueEmail('wrong'));
  await screen.getByRole('button', { name: 'コードを送信' }).click();
  await expect(screen.getByRole('button', { name: /コードを再送（\d+秒後）/ })).toBeDisabled();
  await screen.getByLabel('確認コード').fill('123456');
  await screen.getByRole('button', { name: 'ログイン' }).click();
  await expect(screen.getByRole('alert')).toContainText('確認コードが正しくありません');
  await screen.getByRole('button', { name: 'メールアドレスを入力し直す' }).click();
  await expect(screen.getByLabel('メールアドレス')).toBeVisible();
});

test('ログアウトするとセッションが失効し、保護ページへアクセスできない', async ({ app, screen }) => {
  await login(app, screen, { path: '/login?next=%2Fsettings' });
  await expect(screen.getByRole('heading', { name: '設定' })).toBeVisible();
  await screen.getByRole('button', { name: 'ログアウト' }).click();
  await expect(screen.getByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
  await app.open('/chat/new');
  await expect(screen.getByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
});
