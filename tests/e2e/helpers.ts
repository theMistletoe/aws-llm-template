import { expect, type App, type Screen } from 'e2e';

/** dev-auth の固定コード（ローカル専用。本番ビルドには含まれない） */
export const DEV_CODE = '000000';

let n = 0;
/** テストごとに独立したユーザー */
export function uniqueEmail(prefix = 'e2e'): string {
  n += 1;
  return `${prefix}-${Date.now().toString(36)}-${n}-${Math.random().toString(36).slice(2, 7)}@example.test`;
}

/** ログイン画面でメールアドレス→確認コードの順に入力してログインする */
export async function login(app: App, screen: Screen, options: { email?: string; path?: string } = {}): Promise<string> {
  const email = options.email ?? uniqueEmail();
  await app.open(options.path ?? '/login');
  await expect(screen.getByRole('heading', { name: 'ログイン / 新規登録' })).toBeVisible();
  await screen.getByLabel('メールアドレス').fill(email);
  await screen.getByRole('button', { name: 'コードを送信' }).click();
  await expect(screen.getByRole('status')).toContainText('確認コードを送信しました');
  await screen.getByLabel('確認コード').fill(DEV_CODE);
  await screen.getByRole('button', { name: 'ログイン' }).click();
  return email;
}

/** 入力欄にメッセージを入れてEnterで送信する */
export async function sendMessage(screen: Screen, text: string): Promise<void> {
  const box = screen.getByLabel('メッセージ');
  await box.fill(text);
  await box.press('Enter');
}
