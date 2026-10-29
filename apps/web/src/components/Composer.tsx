import { LIMITS, countChars } from '@ai-chat/contracts';
import { useState, type FormEvent, type KeyboardEvent } from 'react';

/** 入力欄。Enterで送信、Shift+Enterで改行。応答中は送信できず「生成を停止」を表示する（§3 UI要件3） */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const length = countChars(props.value);
  const tooLong = length > LIMITS.maxMessageChars;
  const canSend = !props.streaming && !props.disabled && props.value.trim().length > 0 && !tooLong;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSend) props.onSend(props.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !composing && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
      <label htmlFor="composer" className="sr-only">
        メッセージ
      </label>
      <textarea
        id="composer"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        rows={3}
        placeholder="メッセージを入力（Enterで送信、Shift+Enterで改行）"
        aria-invalid={tooLong}
        aria-describedby="composer-count"
        className="w-full resize-none rounded-lg border border-gray-300 bg-white p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:border-gray-600 dark:bg-gray-800"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span id="composer-count" className={`text-xs ${tooLong ? 'text-red-600' : 'text-gray-500'}`}>
          {length} / {LIMITS.maxMessageChars}
          {tooLong ? '（文字数の上限を超えています）' : ''}
        </span>
        {props.streaming ? (
          <button
            type="button"
            onClick={props.onStop}
            className="rounded-lg border border-gray-400 px-4 py-2 font-medium hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-teal-600 dark:hover:bg-gray-800"
          >
            生成を停止
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-lg bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 focus-visible:ring-2 focus-visible:ring-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            送信
          </button>
        )}
      </div>
    </form>
  );
}
