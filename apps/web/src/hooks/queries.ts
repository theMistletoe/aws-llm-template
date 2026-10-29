import type { ChatMessage, MessageList } from '@ai-chat/contracts';
import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';

export const queryKeys = {
  me: ['me'] as const,
  chats: ['chats'] as const,
  chat: (chatId: string) => ['chat', chatId] as const,
  messages: (chatId: string) => ['messages', chatId] as const,
  usage: ['usage'] as const,
};

/** 4xxは再試行しない（QueryClientの既定値として main.tsx で設定する） */
export const noRetryOn4xx = (count: number, error: unknown) =>
  !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && count < 2;

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, staleTime: 60_000 });
}

export function useChats() {
  return useInfiniteQuery({
    queryKey: queryKeys.chats,
    queryFn: ({ pageParam }) => api.listChats(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useChat(chatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.chat(chatId ?? ''),
    queryFn: () => api.getChat(chatId!),
    enabled: Boolean(chatId),
  });
}

const hasStreaming = (data: InfiniteData<MessageList> | undefined) =>
  data?.pages.some((p) => p.items.some((m) => m.status === 'streaming')) ?? false;

/**
 * メッセージ一覧。ページは新しい順に取得し、表示は時系列昇順に並べる。
 * 生成中のメッセージがある間（リロード後など）は定期的に再取得し、遅延回復の結果（interrupted）も反映する。
 */
export function useMessages(chatId: string | undefined, options: { liveStream: boolean }) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.messages(chatId ?? ''),
    queryFn: ({ pageParam }) => api.listMessages(chatId!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(chatId),
    refetchInterval: (q) => (!options.liveStream && hasStreaming(q.state.data) ? 3000 : false),
  });
  const messages: ChatMessage[] = query.data ? [...query.data.pages].reverse().flatMap((p) => p.items) : [];
  return { ...query, messages };
}

export function useUsage() {
  return useQuery({ queryKey: queryKeys.usage, queryFn: api.usage });
}
