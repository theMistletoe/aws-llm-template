import type { Chat } from '@ai-chat/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import { queryKeys, useChats } from '../hooks/queries';

function ChatRow({ chat, onNavigate }: { chat: Chat; onNavigate: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { chatId } = useParams();
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm-delete'>('view');
  const [title, setTitle] = useState(chat.title);
  const [error, setError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: () => api.renameChat(chat.id, title),
    onSuccess: () => {
      setMode('view');
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'タイトルを変更できませんでした'),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteChat(chat.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      if (chatId === chat.id) navigate('/chat/new');
    },
    onError: (e) => {
      setMode('view');
      setError(e instanceof ApiRequestError && e.code === 'CHAT_BUSY' ? '生成中のチャットは削除できません。先に生成を停止してください。' : '削除できませんでした');
    },
  });

  if (mode === 'rename') {
    return (
      <li className="px-2 py-1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) rename.mutate();
          }}
          className="flex gap-1"
        >
          <label className="sr-only" htmlFor={`rename-${chat.id}`}>
            新しいタイトル
          </label>
          <input
            id={`rename-${chat.id}`}
            value={title}
            maxLength={100}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-0 flex-1 rounded border px-2 py-1 text-sm text-gray-900"
            autoFocus
          />
          <button type="submit" className="rounded bg-teal-700 px-2 text-sm text-white">
            保存
          </button>
          <button type="button" onClick={() => setMode('view')} className="rounded px-2 text-sm">
            取消
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className="group px-2 py-0.5">
      <div className="flex items-center gap-1">
        <NavLink
          to={`/chat/${chat.id}`}
          onClick={onNavigate}
          className={({ isActive }) =>
            `min-w-0 flex-1 truncate rounded px-2 py-1.5 text-sm hover:bg-gray-700 focus-visible:ring-2 focus-visible:ring-teal-400 ${
              isActive ? 'bg-gray-700 font-semibold' : ''
            }`
          }
        >
          {chat.title}
        </NavLink>
        <button
          type="button"
          aria-label={`「${chat.title}」の名前を変更`}
          onClick={() => {
            setTitle(chat.title);
            setMode('rename');
          }}
          className="rounded px-1 text-xs text-gray-300 hover:bg-gray-700"
        >
          名前変更
        </button>
        <button
          type="button"
          aria-label={`「${chat.title}」を削除`}
          onClick={() => setMode('confirm-delete')}
          className="rounded px-1 text-xs text-gray-300 hover:bg-gray-700"
        >
          削除
        </button>
      </div>
      {mode === 'confirm-delete' ? (
        <div role="alertdialog" aria-label="削除の確認" className="mt-1 rounded bg-gray-700 p-2 text-sm">
          <p>このチャットを削除しますか？</p>
          <div className="mt-1 flex gap-2">
            <button type="button" onClick={() => remove.mutate()} className="rounded bg-red-600 px-2 py-0.5 text-white">
              削除する
            </button>
            <button type="button" onClick={() => setMode('view')} className="rounded px-2 py-0.5">
              キャンセル
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-amber-300">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const chats = useChats();
  const items = chats.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <nav aria-label="チャット一覧" className="flex h-full flex-col">
      <div className="p-3">
        <NavLink
          to="/chat/new"
          onClick={onNavigate}
          className="block rounded-lg border border-gray-600 px-3 py-2 text-center text-sm font-medium hover:bg-gray-700 focus-visible:ring-2 focus-visible:ring-teal-400"
        >
          ＋ 新しいチャット
        </NavLink>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {chats.isPending ? <p className="px-4 text-sm text-gray-400">読み込み中…</p> : null}
        {chats.isError ? (
          <p role="alert" className="px-4 text-sm text-amber-300">
            チャット一覧を取得できませんでした
          </p>
        ) : null}
        {chats.isSuccess && items.length === 0 ? <p className="px-4 text-sm text-gray-400">まだチャットはありません</p> : null}
        <ul>
          {items.map((chat) => (
            <ChatRow key={chat.id} chat={chat} onNavigate={onNavigate} />
          ))}
        </ul>
        {chats.hasNextPage ? (
          <button
            type="button"
            onClick={() => void chats.fetchNextPage()}
            disabled={chats.isFetchingNextPage}
            className="m-3 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700"
          >
            さらに表示
          </button>
        ) : null}
      </div>
      <div className="border-t border-gray-700 p-3">
        <NavLink to="/settings" onClick={onNavigate} className="block rounded px-2 py-1.5 text-sm hover:bg-gray-700">
          設定
        </NavLink>
      </div>
    </nav>
  );
}
