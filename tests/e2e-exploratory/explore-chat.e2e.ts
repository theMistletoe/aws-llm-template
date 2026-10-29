import { expect, test } from 'e2e';

/** AIエージェントが画面を操作する探索的テスト（決定的ではないため pnpm test には含めない） */
test('初めてのユーザーがログインして質問し、回答と出典を確認できる', async ({ app, agent, screen }) => {
  await app.open('/');
  await agent.act('メールアドレス欄に explorer@example.test を入力して確認コードを送信し、確認コード 000000 でログインする');
  await agent.act('「最新のAWSニュースを教えて」と質問して送信する');
  await agent.assert('AIの回答と、出典のリンクが表示されている');
  await expect(screen.getByRole('region', { name: '出典' })).toBeVisible();
});
