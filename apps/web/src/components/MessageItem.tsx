import type { ChatMessage, Citation } from '@ai-chat/contracts';
import { Citations } from './Citations';
import { Markdown } from './Markdown';
import { formatMessageTime } from './format';

const STATUS_LABEL: Record<ChatMessage['status'], string | null> = {
  completed: null,
  streaming: '生成中…',
  interrupted: '中断されました',
  failed: '応答に失敗しました',
};

export type MessageView = {
  id: string;
  role: ChatMessage['role'];
  content: string;
  status: ChatMessage['status'];
  createdAt?: string;
  citations?: Citation[];
  searchFailed?: boolean;
  searching?: boolean;
};

export function MessageItem({ message, onRetry }: { message: MessageView; onRetry?: () => void }) {
  const isUser = message.role === 'user';
  const label = STATUS_LABEL[message.status];
  return (
    <article
      aria-label={isUser ? 'あなたのメッセージ' : 'AIの応答'}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[90%] rounded-2xl px-4 py-3 shadow-sm md:max-w-[75%] ${
          isUser ? 'bg-teal-700 text-white' : 'bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100'
        }`}
      >
        <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
          <span className="font-semibold">{isUser ? 'あなた' : 'AI'}</span>
          {message.createdAt ? <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time> : null}
          {label ? (
            <span
              className={`rounded px-1.5 py-0.5 ${
                message.status === 'failed' || message.status === 'interrupted'
                  ? 'bg-amber-100 text-amber-900'
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              {label}
            </span>
          ) : null}
        </div>
        {message.searching ? (
          <p role="status" className="mb-1 text-sm text-gray-500">
            Webを検索中…
          </p>
        ) : null}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : message.content ? (
          <Markdown text={message.content} />
        ) : message.status === 'streaming' ? (
          <p className="text-gray-500">…</p>
        ) : null}
        {message.searchFailed ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            Web検索に失敗したため、検索結果は反映されていません。最新の情報は未確認です。
          </p>
        ) : null}
        {message.citations ? <Citations citations={message.citations} /> : null}
        {onRetry && (message.status === 'failed' || message.status === 'interrupted') ? (
          <button type="button" onClick={onRetry} className="mt-2 rounded border px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
            再送
          </button>
        ) : null}
      </div>
    </article>
  );
}
