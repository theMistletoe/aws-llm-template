import type { ChatMessage } from '@ai-chat/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import { Composer } from '../components/Composer';
import { MessageItem, type MessageView } from '../components/MessageItem';
import { formatResumeTime } from '../components/format';
import { useChatStream, type StreamError, type StreamState } from '../hooks/chat-stream';
import { queryKeys, useChat, useMessages } from '../hooks/queries';

export function streamErrorMessage(error: StreamError): string {
  switch (error.code) {
    case 'QUOTA_EXCEEDED':
      return error.retryAfter
        ? `利用上限に達しました。${formatResumeTime(error.retryAfter)}以降に再開できます。`
        : '利用上限に達しました。';
    case 'CHAT_BUSY':
      return 'このチャットは応答を生成中です。完了するか停止してから送信してください。';
    case 'DUPLICATE_REQUEST':
      return 'このメッセージは既に送信されています。';
    case 'MODEL_TIMEOUT':
      return '応答がタイムアウトしました。再送してください。';
    case 'AGENT_ERROR':
      return '応答の生成に失敗しました。再送してください。';
    case 'NETWORK_ERROR':
      return 'サーバーに接続できませんでした。';
    default:
      return error.message;
  }
}

function liveViews(live: StreamState): MessageView[] {
  const views: MessageView[] = [
    { id: live.userMessageId ?? `pending-user-${live.requestId}`, role: 'user', content: live.content, status: 'completed' },
  ];
  const status: MessageView['status'] =
    live.phase === 'stopped' ? 'interrupted' : live.phase === 'error' ? 'failed' : live.phase === 'done' ? 'completed' : 'streaming';
  views.push({
    id: live.assistantMessageId ?? `pending-assistant-${live.requestId}`,
    role: 'assistant',
    content: live.text,
    status,
    citations: live.sources,
    searching: live.searching,
    searchFailed: live.searchFailed,
  });
  return views;
}

export function ChatPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stream = useChatStream();
  const [draft, setDraft] = useState('');
  /** チャット作成失敗などの画面エラー（表示中のチャットに紐づける） */
  const [pageError, setPageError] = useState<{ chatId: string | undefined; message: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const live = stream.state && stream.state.chatId === chatId ? stream.state : null;
  const chat = useChat(chatId);
  const messages = useMessages(chatId, { liveStream: Boolean(live && stream.isStreaming) });
  const persisted = messages.messages;

  const liveStarted = Boolean(live?.userMessageId);
  const liveFinalized = Boolean(
    live?.assistantMessageId && persisted.some((m) => m.id === live.assistantMessageId && m.status !== 'streaming'),
  );
  const showLive = Boolean(live && (live.phase === 'sending' || live.phase === 'streaming' || liveStarted) && !liveFinalized);
  const hidden = new Set(showLive && live ? [live.userMessageId, live.assistantMessageId].filter(Boolean) : []);
  const visible: MessageView[] = persisted.filter((m) => !hidden.has(m.id));
  const liveItems = showLive && live ? liveViews(live) : [];
  const bannerError = live?.phase === 'error' && live.error && !liveStarted ? live.error : null;
  const streamFailure = live?.phase === 'error' && live.error && liveStarted && !liveFinalized ? live.error : null;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [persisted.length, live?.text, live?.phase]);

  const send = async (content: string) => {
    setDraft('');
    setPageError(null);
    let target = chatId;
    if (!target) {
      try {
        const created = await api.createChat();
        target = created.id;
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
        navigate(`/chat/${created.id}`, { replace: true });
      } catch (e) {
        setDraft(content);
        setPageError({ chatId, message: e instanceof ApiRequestError ? e.message : 'チャットを作成できませんでした' });
        return;
      }
    }
    const outcome = await stream.send(target, content);
    if (outcome === 'rejected') setDraft(content);
  };

  const lastAssistant = [...visible].reverse().find((m) => m.role === 'assistant');
  const retryFor = (m: MessageView) => {
    if (m !== lastAssistant || stream.isStreaming) return undefined;
    const index = visible.indexOf(m);
    const prompt = [...visible.slice(0, index)].reverse().find((x) => x.role === 'user');
    return prompt && chatId ? () => void stream.send(chatId, prompt.content) : undefined;
  };

  if (chatId && chat.error instanceof ApiRequestError && chat.error.status === 404) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold">チャットが見つかりません</h1>
        <p className="mt-2 text-gray-600">削除されたか、アクセスできないチャットです。</p>
        <Link to="/chat/new" className="mt-4 inline-block text-teal-700 underline">
          新しいチャットを始める
        </Link>
      </div>
    );
  }

  const title = chatId ? (chat.data?.title ?? '') : '新しいチャット';

  return (
    <>
      <header className="border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <h1 className="truncate text-lg font-semibold">{title || 'チャット'}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.hasNextPage ? (
            <button
              type="button"
              onClick={() => void messages.fetchNextPage()}
              disabled={messages.isFetchingNextPage}
              className="self-center rounded border px-3 py-1 text-sm hover:bg-white dark:hover:bg-gray-800"
            >
              以前のメッセージを読み込む
            </button>
          ) : null}
          {!chatId && !live ? (
            <p className="mt-10 text-center text-gray-500">
              何でも質問してください。必要に応じてWebを検索し、出典を表示します。
            </p>
          ) : null}
          {messages.isError ? (
            <p role="alert" className="text-amber-700">
              メッセージを取得できませんでした。
            </p>
          ) : null}
          {visible.map((m) => {
            const onRetry = retryFor(m);
            return <MessageItem key={m.id} message={m as ChatMessage} {...(onRetry ? { onRetry } : {})} />;
          })}
          <div aria-live="polite" aria-busy={stream.isStreaming} className="flex flex-col gap-4">
            {liveItems.map((m) => (
              <MessageItem key={m.id} message={m} />
            ))}
          </div>
          {streamFailure ? (
            <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {streamErrorMessage(streamFailure)}
            </div>
          ) : null}
          {bannerError ? (
            <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <p>{streamErrorMessage(bannerError)}</p>
              <div className="mt-2 flex gap-2">
                {bannerError.retryable && bannerError.code !== 'QUOTA_EXCEEDED' ? (
                  <button type="button" onClick={() => void stream.retry()} className="rounded border border-amber-700 px-2 py-0.5">
                    再送
                  </button>
                ) : null}
                <button type="button" onClick={stream.dismiss} className="rounded px-2 py-0.5 underline">
                  閉じる
                </button>
              </div>
            </div>
          ) : null}
          {pageError && pageError.chatId === chatId ? (
            <p role="alert" className="text-amber-700">
              {pageError.message}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={(c) => void send(c)}
        onStop={stream.stop}
        streaming={stream.isStreaming}
      />
    </>
  );
}
