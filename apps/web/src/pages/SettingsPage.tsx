import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { queryKeys, useMe } from '../hooks/queries';

export function SettingsPage() {
  const me = useMe();
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
      </div>
    </div>
  );
}
