import { Link, useSearchParams } from 'react-router';

const MESSAGES: Record<string, { title: string; body: string }> = {
  '403': { title: 'アクセスが拒否されました', body: 'このページを表示する権限がありません。' },
  '404': { title: 'ページが見つかりません', body: 'URLが正しいか確認してください。' },
  '500': { title: 'エラーが発生しました', body: '時間をおいて再度お試しください。' },
};

export function ErrorPage({ code }: { code?: string }) {
  const [params] = useSearchParams();
  const key = code ?? params.get('code') ?? '500';
  const msg = MESSAGES[key] ?? MESSAGES['500']!;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-100 p-6 text-center dark:bg-gray-950 dark:text-gray-100">
      <div>
        <p className="text-sm text-gray-500">{key}</p>
        <h1 className="text-2xl font-bold">{msg.title}</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-300">{msg.body}</p>
        <div className="mt-4 flex justify-center gap-3">
          <button type="button" onClick={() => window.location.reload()} className="rounded border px-3 py-1">
            再試行
          </button>
          <Link to="/" className="rounded bg-teal-700 px-3 py-1 text-white">
            ホームへ戻る
          </Link>
        </div>
        <p className="mt-4 text-xs text-gray-500">問題が解決しない場合は、サービスの管理者にお問い合わせください。</p>
      </div>
    </main>
  );
}
