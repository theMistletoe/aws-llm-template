import { createHash } from 'node:crypto';
import { z } from 'zod';

/** BFF → AgentCore Runtime の内部契約（§6.3）。Runtime側でもZodで検証する */
export const agentInvokeRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().min(1).max(64),
  chatId: z.string().min(1).max(64),
  /** BFFで認証・認可済み。一般ユーザーからの入力は不可 */
  userSub: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  /** 直近10往復（最大20件） */
  context: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().max(64_000) }))
    .max(20),
  options: z.strictObject({
    allowWebSearch: z.boolean(),
    maxToolCalls: z.number().int().min(0).max(3),
    maxOutputTokens: z.number().int().min(1).max(2048),
  }),
});
export type AgentInvokeRequest = z.infer<typeof agentInvokeRequestSchema>;

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('tool_status'),
    tool: z.literal('web_search'),
    status: z.enum(['running', 'done', 'failed']),
  }),
  z.object({
    type: z.literal('source'),
    title: z.string(),
    url: z.string(),
    publishedDate: z.string().optional(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    searchCalls: z.number().int().min(0),
  }),
  z.object({ type: z.literal('done'), reason: z.enum(['complete', 'cancelled', 'max_tokens']) }),
  z.object({ type: z.literal('error'), code: z.string(), retryable: z.boolean() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export interface AgentRunner {
  run(request: AgentInvokeRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** 会話のAgentCoreセッションを停止する（会話削除・クライアント中断時）。失敗しても例外にしない */
  stopSession?(params: { chatId: string; userSub: string }): Promise<void>;
}

/** Agent側のエラーコード */
export const AGENT_ERROR_CODES = {
  invalidRequest: 'INVALID_REQUEST',
  modelError: 'MODEL_ERROR',
  modelTimeout: 'MODEL_TIMEOUT',
  throttled: 'MODEL_THROTTLED',
  internal: 'AGENT_ERROR',
} as const;

/**
 * 会話ごとのAgentCoreセッションID（§6.2）。
 * `chat-<chatId>-<sha256(userSub)の先頭16桁>`。AgentCoreの制約（33〜256文字）を満たす。
 */
export function runtimeSessionIdFor(chatId: string, userSub: string): string {
  const id = `chat-${chatId}-${createHash('sha256').update(userSub).digest('hex').slice(0, 16)}`;
  if (id.length < 33 || id.length > 256) throw new Error(`runtime session id length out of range: ${id.length}`);
  return id;
}

/** AgentEvent を SSE の1フレームに変換する（Agent → BFF のワイヤーフォーマット） */
export function encodeAgentEvent(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** SSEフレームの data を AgentEvent として検証する。不正なら null */
export function decodeAgentEvent(data: string): AgentEvent | null {
  try {
    const result = agentEventSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
