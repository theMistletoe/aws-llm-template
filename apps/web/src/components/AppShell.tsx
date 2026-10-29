import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';

/** デスクトップは2カラム、スマホは折り畳みサイドバー（§3 UI要件1） */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-white focus:p-2">
        本文へスキップ
      </a>
      <aside
        id="sidebar"
        className={`${open ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'} w-72 flex-col bg-gray-900 text-gray-100 md:static md:flex`}
      >
        <Sidebar onNavigate={() => setOpen(false)} />
      </aside>
      {open ? <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 md:hidden dark:border-gray-700 dark:bg-gray-900">
          <button
            type="button"
            aria-controls="sidebar"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded px-2 py-1 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-teal-600 dark:hover:bg-gray-800"
          >
            メニュー
          </button>
          <span className="font-semibold">AI Chat</span>
        </div>
        <main id="main" className="flex min-h-0 flex-1 flex-col">
          {children}
        </main>
      </div>
    </div>
  );
}
