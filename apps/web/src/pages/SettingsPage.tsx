import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { formatResumeTime } from '../components/format';
import { queryKeys, useMe, useUsage } from '../hooks/queries';

export function SettingsPage() {
  const me = useMe();
  const usage = useUsage();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.setQueryData(queryKeys.me, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      navigate('/login', { replace: true });
    },
  });
  const u = usage.data;
  return (
    <div className="overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-xl font-bold">設定</h1>
        <section aria-labelledby="account" className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-900">
          <h2 id="account" className="mb-2 font-semibold">
            アカウント
          </h2>
          <p>
            メールアドレス: <span className="font-mono">{me.data?.email}</span>
          </p>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="mt-3 rounded-lg border border-gray-400 px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            ログアウト
          </button>
        </section>
        <section aria-labelledby="usage" className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-900">
          <h2 id="usage" className="mb-2 font-semibold">
            使用量
          </h2>
          {usage.isPending ? <p>読み込み中…</p> : null}
          {usage.isError ? <p role="alert">使用量を取得できませんでした。</p> : null}
          {u ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt>本日の生成回数</dt>
              <dd>
                {u.daily.requests} / {u.daily.requestLimit}
              </dd>
              <dt>この1時間の生成回数</dt>
              <dd>
                {u.hourly.requests} / {u.hourly.requestLimit}
              </dd>
              <dt>本日のWeb検索回数</dt>
              <dd>
                {u.daily.searches} / {u.daily.searchLimit}
              </dd>
              <dt>日次リセット</dt>
              <dd>{formatResumeTime(u.daily.resetsAt)}</dd>
            </dl>
          ) : null}
          <p className="mt-2 text-xs text-gray-500">中断・失敗した生成も1回として数えます。</p>
        </section>
      </div>
    </div>
  );
}
