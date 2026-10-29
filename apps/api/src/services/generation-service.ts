import type { AgentInvokeRequest } from '@ai-chat/agent-contracts';
import {
  SSE_HEARTBEAT,
  deriveTitle,
  formatSseEvent,
  isSafeHttpUrl,
  type Citation,
  type SendMessageInput,
} from '@ai-chat/contracts';
import type { AppDeps, SessionUser } from '../deps';
import { errors } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { dayKey, epochSeconds, hourKey, nextDayStart, nextHourStart } from '../lib/time';
import { StartRunConflict, type MessageItem } from '../repositories/chat-repository';
import type { ChatService } from './chat-service';

const MAX_CITATIONS = 10;

class GenerationAbort extends Error {
  constructor(readonly kind: 'client' | 'timeout') {
    super(kind);
    this.name = 'GenerationAbort';
  }
}

type ContextMessage = AgentInvokeRequest['context'][number];

/**
 * 履歴を AgentInvokeRequest.context 用に整える。
 * 連続する同一ロールは結合し、先頭はuser・末尾はassistantにそろえる（未回答のuser発言は除く）。
 */
export function buildContext(history: Pick<MessageItem, 'role' | 'content'>[], maxMessages: number): ContextMessage[] {
  const merged: ContextMessage[] = [];
  for (const m of history) {
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  let window = merged.slice(-maxMessages);
  while (window[0]?.role === 'assistant') window = window.slice(1);
  while (window.at(-1)?.role === 'user') window = window.slice(0, -1);
  return window;
}

type Accumulator = {
  content: string;
  citations: Citation[];
  usage: { inputTokens: number; outputTokens: number; searchCalls: number };
  searched: boolean;
  searchFailed: boolean;
  finish?: 'complete' | 'max_tokens' | 'cancelled';
  error?: { code: string; retryable: boolean };
};

/** 生成開始＋SSE中継（§5.2, §7.3） */
export class GenerationService {
  constructor(
    private readonly deps: AppDeps,
    private readonly chatService: ChatService,
  ) {}

  async start(params: {
    user: SessionUser;
    chatId: string;
    input: SendMessageInput;
    requestSignal: AbortSignal;
    requestId: string;
    logger: Logger;
  }): Promise<Response> {
    const { config, chats, clock } = this.deps;
    const { user, chatId, input } = params;
    const meta = await this.chatService.recover(await this.chatService.requireOwnedChat(user.sub, chatId));
    const now = clock.now();
    if (meta.activeRunId && (meta.lockExpiresAt ?? 0) >= now.getTime()) throw errors.chatBusy();

    const tz = config.quota.timeZone;
    const day = dayKey(now, tz);
    const hour = hourKey(now, tz);
    const [usage, history] = await Promise.all([
      chats.getUsage(user.sub, day, hour),
      chats.recentCompletedMessages(chatId, config.generation.contextTurns * 2),
    ]);
    // 検索の日次上限に達したら検索なしで生成する（最後の1回答で最大3回まで超過し得る。§8）
    const allowWebSearch = config.webSearchEnabled && usage.daily.searches < config.quota.dailySearches;
    const userMessageId = this.deps.newId();
    const assistantMessageId = this.deps.newId();
    const usageExpiresAt = epochSeconds(now) + config.quota.retentionDays * 86_400;

    try {
      await chats.startRun({
        chatId,
        ownerSub: user.sub,
        requestId: input.requestId,
        userMessageId,
        assistantMessageId,
        content: input.content,
        ...(meta.titleSource === 'default' ? { autoTitle: deriveTitle(input.content) } : {}),
        now,
        lockExpiresAt: now.getTime() + config.generation.lockTtlSeconds * 1000,
        modelId: config.modelId,
        usage: {
          dayKey: day,
          hourKey: hour,
          dailyLimit: config.quota.dailyRequests,
          hourlyLimit: config.quota.hourlyRequests,
          expiresAt: usageExpiresAt,
        },
      });
    } catch (e) {
      if (e instanceof StartRunConflict) throw await this.explainConflict(e, user.sub, chatId, input.requestId, now);
      throw e;
    }

    const request: AgentInvokeRequest = {
      version: 1,
      requestId: input.requestId,
      chatId,
      userSub: user.sub,
      message: input.content,
      context: buildContext(history, config.generation.contextTurns * 2),
      options: {
        allowWebSearch,
        maxToolCalls: config.generation.maxToolCalls,
        maxOutputTokens: config.generation.maxOutputTokens,
      },
    };
    return this.stream({
      request,
      userMessageId,
      assistantMessageId,
      requestSignal: params.requestSignal,
      httpRequestId: params.requestId,
      logger: params.logger.child({ chatId }),
      dayKey: day,
      usageExpiresAt,
    });
  }

  /** トランザクション失敗の理由を判定する（CancellationReasonsが無い実装でも読み直して判定） */
  private async explainConflict(conflict: StartRunConflict, ownerSub: string, chatId: string, requestId: string, now: Date) {
    const tz = this.deps.config.quota.timeZone;
    let reasons = conflict.reasons;
    if (reasons.includes('unknown')) {
      reasons = [];
      if (await this.deps.chats.getRun(chatId, requestId)) reasons.push('duplicate');
      const meta = await this.deps.chats.getMeta(chatId);
      if (!meta || meta.deletedAt || meta.ownerSub !== ownerSub || (meta.activeRunId && (meta.lockExpiresAt ?? 0) >= now.getTime()))
        reasons.push('busy_or_gone');
      const usage = await this.deps.chats.getUsage(ownerSub, dayKey(now, tz), hourKey(now, tz));
      if (usage.daily.requests >= this.deps.config.quota.dailyRequests) reasons.push('quota_daily');
      if (usage.hourly.requests >= this.deps.config.quota.hourlyRequests) reasons.push('quota_hourly');
    }
    if (reasons.includes('duplicate')) return errors.duplicateRequest();
    if (reasons.includes('busy_or_gone')) {
      const meta = await this.deps.chats.getMeta(chatId);
      if (!meta || meta.deletedAt || meta.ownerSub !== ownerSub) return errors.notFound();
      return errors.chatBusy();
    }
    if (reasons.includes('quota_daily')) return errors.quotaExceeded(nextDayStart(now, tz).toISOString());
    if (reasons.includes('quota_hourly')) return errors.quotaExceeded(nextHourStart(now, tz).toISOString());
    return errors.chatBusy();
  }

  private stream(p: {
    request: AgentInvokeRequest;
    userMessageId: string;
    assistantMessageId: string;
    requestSignal: AbortSignal;
    httpRequestId: string;
    logger: Logger;
    dayKey: string;
    usageExpiresAt: number;
  }): Response {
    const { config } = this.deps;
    const encoder = new TextEncoder();
    const abort = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let clientGone = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;

    const markClientGone = () => {
      if (clientGone) return;
      clientGone = true;
      if (!abort.signal.aborted) abort.abort(new GenerationAbort('client'));
    };
    const scheduleHeartbeat = () => {
      clearTimeout(heartbeat);
      // 無通信が一定時間続いたらコメント行を送る（CloudFrontのオリジン応答タイムアウト対策）
      heartbeat = setTimeout(() => send(SSE_HEARTBEAT), config.generation.heartbeatIntervalMs);
    };
    const send = (chunk: string) => {
      if (clientGone) return;
      try {
        controller.enqueue(encoder.encode(chunk));
        scheduleHeartbeat();
      } catch {
        markClientGone();
      }
    };
    const onRequestAbort = () => markClientGone();
    p.requestSignal.addEventListener('abort', onRequestAbort, { once: true });
    if (p.requestSignal.aborted) markClientGone();

    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        void this.pump(p, abort, send, () => clientGone).finally(() => {
          clearTimeout(heartbeat);
          p.requestSignal.removeEventListener('abort', onRequestAbort);
          if (!clientGone) {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        });
      },
      cancel: () => markClientGone(),
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': p.httpRequestId,
      },
    });
  }

  private async pump(
    p: Parameters<GenerationService['stream']>[0],
    abort: AbortController,
    send: (chunk: string) => void,
    isClientGone: () => boolean,
  ): Promise<void> {
    const { config, chats, agent, clock } = this.deps;
    const { request } = p;
    const started = performance.now();
    const acc: Accumulator = {
      content: '',
      citations: [],
      usage: { inputTokens: 0, outputTokens: 0, searchCalls: 0 },
      searched: false,
      searchFailed: false,
    };
    const timeout = setTimeout(() => abort.abort(new GenerationAbort('timeout')), config.generation.timeoutMs);

    send(
      formatSseEvent('start', {
        requestId: request.requestId,
        chatId: request.chatId,
        userMessageId: p.userMessageId,
        assistantMessageId: p.assistantMessageId,
      }),
    );

    try {
      for await (const ev of agent.run(request, abort.signal)) {
        if (abort.signal.aborted) break;
        switch (ev.type) {
          case 'delta':
            acc.content += ev.text;
            send(formatSseEvent('delta', { text: ev.text }));
            break;
          case 'tool_status':
            acc.searched = true;
            if (ev.status === 'failed') acc.searchFailed = true;
            send(formatSseEvent('tool_status', { tool: ev.tool, status: ev.status }));
            break;
          case 'source': {
            // 引用URLはhttp/httpsのみ。重複と件数上限も制御する（§6.7）
            if (!isSafeHttpUrl(ev.url) || acc.citations.some((c) => c.url === ev.url)) break;
            if (acc.citations.length >= MAX_CITATIONS) break;
            const citation: Citation = {
              title: ev.title.slice(0, 300) || ev.url,
              url: ev.url,
              ...(ev.publishedDate ? { publishedDate: ev.publishedDate.slice(0, 40) } : {}),
            };
            acc.citations.push(citation);
            send(formatSseEvent('source', citation));
            break;
          }
          case 'usage':
            acc.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, searchCalls: ev.searchCalls };
            break;
          case 'done':
            acc.finish = ev.reason;
            break;
          case 'error':
            acc.error = { code: ev.code, retryable: ev.retryable };
            break;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        acc.error = { code: (e as Error).name === 'TimeoutError' ? 'MODEL_TIMEOUT' : 'AGENT_ERROR', retryable: true };
        p.logger.error('agent_stream_failed', { errorClass: (e as Error).name });
      }
    } finally {
      clearTimeout(timeout);
    }

    const abortKind = abort.signal.aborted ? (abort.signal.reason as GenerationAbort | undefined)?.kind : undefined;
    let status: 'completed' | 'failed' | 'interrupted';
    let sseError: { code: string; message: string; retryable: boolean } | undefined;
    if (abortKind === 'client') {
      status = 'interrupted';
    } else if (abortKind === 'timeout') {
      status = 'failed';
      sseError = { code: 'MODEL_TIMEOUT', message: '応答がタイムアウトしました', retryable: true };
    } else if (acc.error) {
      status = 'failed';
      sseError =
        acc.error.code === 'MODEL_TIMEOUT'
          ? { code: 'MODEL_TIMEOUT', message: '応答がタイムアウトしました', retryable: true }
          : { code: 'AGENT_ERROR', message: '応答の生成に失敗しました', retryable: acc.error.retryable };
    } else if (acc.finish === 'cancelled') {
      status = 'interrupted';
    } else if (acc.finish) {
      status = 'completed';
    } else {
      status = 'failed';
      sseError = { code: 'AGENT_ERROR', message: '応答が途中で終了しました', retryable: true };
    }

    if (abortKind) {
      // 中断・タイムアウト時は実行環境を解放する。失敗してもアイドルタイムアウトで解放される（§6.2）
      void this.stopSession(request, p.logger);
    }

    try {
      await chats.finishRun({
        chatId: request.chatId,
        ownerSub: request.userSub,
        requestId: request.requestId,
        assistantMessageId: p.assistantMessageId,
        status,
        content: acc.content,
        citations: acc.citations,
        usage: acc.usage,
        searched: acc.searched,
        searchFailed: acc.searchFailed,
        ...(sseError ? { errorCode: sseError.code } : {}),
        now: clock.now(),
        dayKey: p.dayKey,
        usageExpiresAt: p.usageExpiresAt,
      });
    } catch (e) {
      // 保存に失敗してもロックは期限切れ後の遅延回復で整合する
      p.logger.error('finish_run_failed', { errorClass: (e as Error).name });
    }

    p.logger.info('generation_finished', {
      status,
      finishReason: acc.finish,
      errorCode: sseError?.code,
      latencyMs: Math.round(performance.now() - started),
      modelId: config.modelId,
      usage: { inputTokens: acc.usage.inputTokens, outputTokens: acc.usage.outputTokens },
      toolCalls: acc.usage.searchCalls,
      webSearchAllowed: request.options.allowWebSearch,
    });

    if (isClientGone()) return;
    if (sseError) {
      send(formatSseEvent('error', sseError));
    } else {
      send(
        formatSseEvent('done', {
          messageId: p.assistantMessageId,
          finishReason: status === 'interrupted' ? 'cancelled' : (acc.finish ?? 'complete'),
          usage: { inputTokens: acc.usage.inputTokens, outputTokens: acc.usage.outputTokens },
        }),
      );
    }
  }

  private async stopSession(request: AgentInvokeRequest, logger: Logger): Promise<void> {
    if (!this.deps.agent.stopSession) return;
    try {
      await this.deps.agent.stopSession({ chatId: request.chatId, userSub: request.userSub });
    } catch (e) {
      logger.warn('stop_session_failed', { errorClass: (e as Error).name });
    }
  }
}
