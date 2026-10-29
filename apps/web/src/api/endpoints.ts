import type { Chat, ChatList, Me, MessageList, OtpStartResponse, Usage } from '@ai-chat/contracts';
import { ApiRequestError, apiFetch } from './client';

export const api = {
  async me(): Promise<Me | null> {
    try {
      return await apiFetch<Me>('/api/auth/me');
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) return null;
      throw e;
    }
  },
  startOtp: (email: string) => apiFetch<OtpStartResponse>('/api/auth/otp/start', { method: 'POST', body: { email } }),
  /** 204 → undefined（ログイン完了）/ 202 → { status: 'additional_code_sent' } */
  verifyOtp: (code: string) =>
    apiFetch<{ status: 'additional_code_sent'; message: string } | undefined>('/api/auth/otp/verify', {
      method: 'POST',
      body: { code },
    }),
  logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST', body: {} }),
  listChats: (cursor?: string) =>
    apiFetch<ChatList>(`/api/v1/chats?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  createChat: (title?: string) => apiFetch<Chat>('/api/v1/chats', { method: 'POST', body: title ? { title } : {} }),
  getChat: (chatId: string) => apiFetch<Chat>(`/api/v1/chats/${encodeURIComponent(chatId)}`),
  renameChat: (chatId: string, title: string) =>
    apiFetch<Chat>(`/api/v1/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: { title } }),
  deleteChat: (chatId: string) => apiFetch<void>(`/api/v1/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' }),
  listMessages: (chatId: string, cursor?: string) =>
    apiFetch<MessageList>(
      `/api/v1/chats/${encodeURIComponent(chatId)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  usage: () => apiFetch<Usage>('/api/v1/usage'),
};
