import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useMe } from '../hooks/queries';

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center p-6 text-center text-gray-600 dark:bg-gray-950 dark:text-gray-300">
      <div>{children}</div>
    </div>
  );
}

/** 未認証ならログイン画面へ（戻り先を next に保持） */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageMessage>読み込み中…</FullPageMessage>;
  if (me.isError) {
    return (
      <FullPageMessage>
        <p role="alert">サーバーに接続できませんでした。</p>
        <button type="button" onClick={() => void me.refetch()} className="mt-3 rounded border px-3 py-1">
          再試行
        </button>
      </FullPageMessage>
    );
  }
  if (!me.data) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
