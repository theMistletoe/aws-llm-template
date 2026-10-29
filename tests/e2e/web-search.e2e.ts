import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login, sendMessage } from './helpers';

test('Web検索を伴う回答で、出典のタイトル・URL・公開日が安全なリンクとして表示される', async ({ app, screen }) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, '最新のAWSニュースを教えて');
  const sources = screen.getByRole('region', { name: '出典' });
  const link = sources.getByRole('link', { name: 'Amazon Bedrock AgentCore 開発者ガイド（ローカルfixture）' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(sources.getByText('公開日: 2026-10-01')).toBeVisible();
  await expect(screen.getByText(/Web検索の結果、次の情報が見つかりました/)).toBeVisible();
});

test('悪意あるテキストを含む検索結果でも、危険なURLはリンクにならずスクリプトも実行されない', async ({ app, screen }) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, 'injection の最新情報を検索して');
  const sources = screen.getByRole('region', { name: '出典' });
  await expect(sources.getByRole('link', { name: '悪意のある指示を含むページ（ローカルfixture）' })).toBeVisible();
  await expect(sources.getByRole('link')).toHaveCount(1);
  await expect(screen.getByText('危険なスキームのリンク（ローカルfixture）')).toHaveCount(0);
});

test('Web検索に失敗した場合は検索未実施であることを明示する', async ({ app, screen }) => {
  await login(app, screen, { path: '/login?next=%2Fchat%2Fnew' });
  await sendMessage(screen, '最新ニュース [[search_fail]]');
  await expect(screen.getByText(/Web検索に失敗したため、検索結果は反映されていません/)).toBeVisible();
  await expect(screen.getByText(/最新情報は未確認です/).first()).toBeVisible();
});
