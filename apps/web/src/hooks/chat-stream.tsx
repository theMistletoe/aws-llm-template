import type { Citation, StreamEvent } from '@ai-chat/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { uuidv7 } from 'uuidv7';
import { ApiRequestError } from '../api/client';
import { StreamInterruptedError, streamChat } from '../api/stream';
import { queryKeys } from './queries';

export type StreamError = { code: string; message: string; retryable: boolean; retryAfter?: string };

export type StreamState = {
  chatId: string;
  requestId: string;
  content: string;
  phase: 'sending' | 'streaming' | 'done' | 'error' | 'stopped';
  userMessageId?: string;
  assistantMessageId?: string;
  text: string;
  searching: boolean;
  searchFailed: boolean;
  searched: boolean;
  sources: Citation[];
  finishReason?: 'complete' | 'max_tokens' | 'cancelled';
  error?: StreamError;
};

export type SendOutcome = 'started' | 'rejected' | 'busy';

type ChatStreamApi = {
  state: StreamState | null;
  isStreaming: boolean;
  send: (chatId: string, content: string) => Promise<SendOutcome>;
  stop: () => void;
  retry: () => Promise<SendOutcome>;
  dismiss: () => void;
};

const ChatStreamContext = createContext<ChatStreamApi | null>(null);

function reduce(state: StreamState, event: StreamEvent): StreamState {
  switch (event.event) {
    case 'start':
      return {
        ...state,
        phase: 'streaming',
        userMessageId: event.data.userMessageId,
        assistantMessageId: event.data.assistantMessageId,
      };
    case 'delta':
      return { ...state, phase: 'streaming', text: state.text + event.data.text };
    case 'tool_status':
      return {
        ...state,
        searched: true,
        searching: event.data.status === 'running',
        searchFailed: state.searchFailed || event.data.status === 'failed',
      };
    case 'source':
      return state.sources.some((s) => s.url === event.data.url) ? state : { ...state, sources: [...state.sources, event.data] };
    case 'done':
      return { ...state, phase: 'done', searching: false, finishReason: event.data.finishReason };
    case 'error':
      return { ...state, phase: 'error', searching: false, error: event.data };
  }
}

const NETWORK_ERROR: StreamError = {
  code: 'STREAM_INTERRUPTED',
  message: '通信が切断されました。応答の状態を確認しています。',
  retryable: true,
};

/** 生成ストリームの状態をルート遷移（/chat/new → /chat/:id）をまたいで保持する */
export function ChatStreamProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(false);

  const refresh = useCallback(
    (chatId: string) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages(chatId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    },
    [queryClient],
  );

  const send = useCallback(
    async (chatId: string, content: string): Promise<SendOutcome> => {
      // 応答中の二重送信を止める（§3 UI要件3）
      if (activeRef.current) return 'busy';
      activeRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      let current: StreamState = {
        chatId,
        requestId: uuidv7(),
        content,
        phase: 'sending',
        text: '',
        searching: false,
        searchFailed: false,
        searched: false,
        sources: [],
      };
      setState(current);
      const update = (next: StreamState) => {
        current = next;
        setState(next);
      };
      try {
        await streamChat({
          chatId,
          requestId: current.requestId,
          content,
          signal: controller.signal,
          onEvent: (event) => update(reduce(current, event)),
        });
        return 'started';
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          update({ ...current, phase: 'stopped', searching: false });
          // サーバー側で interrupted として確定するまで少し待ってから再取得する
          setTimeout(() => refresh(chatId), 500);
          return 'started';
        }
        if (e instanceof ApiRequestError) {
          update({
            ...current,
            phase: 'error',
            error: { code: e.code, message: e.message, retryable: e.retryable, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) },
          });
          return current.userMessageId ? 'started' : 'rejected';
        }
        update({ ...current, phase: 'error', searching: false, error: e instanceof StreamInterruptedError ? NETWORK_ERROR : NETWORK_ERROR });
        return current.userMessageId ? 'started' : 'rejected';
      } finally {
        activeRef.current = false;
        abortRef.current = null;
        refresh(chatId);
      }
    },
    [refresh],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const retry = useCallback(async () => (state ? send(state.chatId, state.content) : ('rejected' as const)), [send, state]);
  const dismiss = useCallback(() => setState(null), []);

  const value = useMemo<ChatStreamApi>(
    () => ({
      state,
      isStreaming: state?.phase === 'sending' || state?.phase === 'streaming',
      send,
      stop,
      retry,
      dismiss,
    }),
    [state, send, stop, retry, dismiss],
  );
  return <ChatStreamContext.Provider value={value}>{children}</ChatStreamContext.Provider>;
}

export function useChatStream(): ChatStreamApi {
  const ctx = useContext(ChatStreamContext);
  if (!ctx) throw new Error('useChatStream must be used within ChatStreamProvider');
  return ctx;
}
