import { DEFAULT_CHAT_TITLE, type Chat, type ChatList, type MessageList, type Usage } from '@ai-chat/contracts';
import type { AppDeps } from '../deps';
import { errors } from '../lib/errors';
import { dayKey, hourKey, nextDayStart, nextHourStart } from '../lib/time';
import { isUlid } from '../lib/validation';
import { toChat, toMessage, type ChatMetaItem } from '../repositories/chat-repository';

/** チャットCRUD・所有者検証・遅延回復（§4.4, §7） */
export class ChatService {
  constructor(private readonly deps: AppDeps) {}

  /** 存在しない／他人／削除済みのチャットはいずれも404（§4.4） */
  async requireOwnedChat(ownerSub: string, chatId: string): Promise<ChatMetaItem> {
    if (!isUlid(chatId)) throw errors.notFound();
    const meta = await this.deps.chats.getMeta(chatId);
    if (!meta || meta.ownerSub !== ownerSub || meta.deletedAt) throw errors.notFound();
    return meta;
  }

  /** 期限切れロックが残っていれば遅延回復する（§7.4） */
  async recover(meta: ChatMetaItem): Promise<ChatMetaItem> {
    const now = this.deps.clock.now();
    if (!meta.activeRunId || meta.lockExpiresAt === undefined || meta.lockExpiresAt >= now.getTime()) return meta;
    const recovered = await this.deps.chats.recoverStaleRun(meta, now);
    this.deps.logger.warn('stale_run_recovered', { chatId: meta.chatId });
    return recovered;
  }

  async list(ownerSub: string, limit = 30, cursor?: string): Promise<ChatList> {
    const { items, nextCursor } = await this.deps.chats.listChats(ownerSub, limit, cursor);
    return { items: items.map(toChat), nextCursor };
  }

  async create(ownerSub: string, title?: string): Promise<Chat> {
    const meta = await this.deps.chats.createChat({
      chatId: this.deps.newId(),
      ownerSub,
      title: title ?? DEFAULT_CHAT_TITLE,
      titleSource: title ? 'user' : 'default',
      now: this.deps.clock.now(),
    });
    return toChat(meta);
  }

  async get(ownerSub: string, chatId: string): Promise<Chat> {
    return toChat(await this.requireOwnedChat(ownerSub, chatId));
  }

  async rename(ownerSub: string, chatId: string, title: string): Promise<Chat> {
    await this.requireOwnedChat(ownerSub, chatId);
    const updated = await this.deps.chats.updateTitle(chatId, ownerSub, title, this.deps.clock.now());
    if (!updated) throw errors.notFound();
    return toChat(updated);
  }

  /** 論理削除＋関連メッセージのページング削除＋AgentCoreセッション停止。生成中は409 */
  async delete(ownerSub: string, chatId: string): Promise<void> {
    const meta = await this.recover(await this.requireOwnedChat(ownerSub, chatId));
    const result = await this.deps.chats.softDelete(meta.chatId, ownerSub, this.deps.clock.now());
    if (result === 'not_found') throw errors.notFound();
    if (result === 'busy') throw errors.chatBusy();
    await this.deps.chats.purgeChatItems(chatId);
    if (this.deps.agent.stopSession) {
      try {
        await this.deps.agent.stopSession({ chatId, userSub: ownerSub });
      } catch (e) {
        this.deps.logger.warn('stop_session_failed', { chatId, errorClass: (e as Error).name });
      }
    }
  }

  async listMessages(ownerSub: string, chatId: string, limit = 50, cursor?: string): Promise<MessageList> {
    await this.recover(await this.requireOwnedChat(ownerSub, chatId));
    const { items, nextCursor } = await this.deps.chats.listMessages(chatId, limit, cursor);
    return { items: items.map(toMessage), nextCursor };
  }

  async usage(ownerSub: string): Promise<Usage> {
    const now = this.deps.clock.now();
    const { timeZone, dailyRequests, hourlyRequests, dailySearches } = this.deps.config.quota;
    const day = dayKey(now, timeZone);
    const hour = hourKey(now, timeZone);
    const counts = await this.deps.chats.getUsage(ownerSub, day, hour);
    return {
      timeZone,
      daily: {
        date: day,
        requests: counts.daily.requests,
        requestLimit: dailyRequests,
        searches: counts.daily.searches,
        searchLimit: dailySearches,
        resetsAt: nextDayStart(now, timeZone).toISOString(),
      },
      hourly: {
        hour,
        requests: counts.hourly.requests,
        requestLimit: hourlyRequests,
        resetsAt: nextHourStart(now, timeZone).toISOString(),
      },
    };
  }
}
