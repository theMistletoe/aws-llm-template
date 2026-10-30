import { z } from 'zod';

export const LIMITS = {
  /** 1メッセージの最大文字数（コードポイント単位） */
  maxMessageChars: 4000,
  /** 1メッセージの最大バイト数（UTF-8） */
  maxMessageBytes: 16_000,
  titleMaxChars: 100,
  autoTitleChars: 30,
  emailMaxLength: 254,
} as const;

export const DEFAULT_CHAT_TITLE = '新しいチャット';

const textEncoder = new TextEncoder();
export const countChars = (s: string): number => [...s].length;
export const countBytes = (s: string): number => textEncoder.encode(s).length;

// ---------------------------------------------------------------------------
// ドメインモデル（§5.1）
// ---------------------------------------------------------------------------

export const citationSchema = z.object({
  title: z.string(),
  url: z.string(),
  publishedDate: z.string().optional(),
});
export type Citation = z.infer<typeof citationSchema>;

export const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;

export const messageStatusSchema = z.enum(['completed', 'streaming', 'interrupted', 'failed']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: messageStatusSchema,
  citations: z.array(citationSchema).optional(),
  /** Web検索を実行した場合のみ。検索が失敗した場合は searchFailed=true */
  searchFailed: z.boolean().optional(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

const messageContent = z
  .string()
  .refine((s) => s.trim().length > 0, { message: 'メッセージを入力してください' })
  .refine((s) => countChars(s) <= LIMITS.maxMessageChars, {
    message: `メッセージは${LIMITS.maxMessageChars}文字以内で入力してください`,
  })
  .refine((s) => countBytes(s) <= LIMITS.maxMessageBytes, { message: 'メッセージが長すぎます' });

const title = z
  .string()
  .trim()
  .min(1, 'タイトルを入力してください')
  .refine((s) => countChars(s) <= LIMITS.titleMaxChars, {
    message: `タイトルは${LIMITS.titleMaxChars}文字以内で入力してください`,
  });

export const sendMessageInputSchema = z.strictObject({
  /** UUIDv7: 重複送信防止 */
  requestId: z.uuid({ version: 'v7' }),
  content: messageContent,
});
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const createChatInputSchema = z.strictObject({
  title: title.optional(),
});
export type CreateChatInput = z.infer<typeof createChatInputSchema>;

export const updateChatInputSchema = z.strictObject({ title });
export type UpdateChatInput = z.infer<typeof updateChatInputSchema>;

export const otpStartInputSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(LIMITS.emailMaxLength)
    .pipe(z.email({ message: 'メールアドレスの形式が正しくありません' })),
});
export type OtpStartInput = z.infer<typeof otpStartInputSchema>;

/** CognitoのメールOTPは6〜8桁（PoCで確認）。dev-authは000000 */
export const otpVerifyInputSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^\d{6,8}$/, { message: '確認コードは数字で入力してください' }),
});
export type OtpVerifyInput = z.infer<typeof otpVerifyInputSchema>;

export const paginationQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// レスポンス
// ---------------------------------------------------------------------------

export const meSchema = z.object({ sub: z.string(), email: z.string() });
export type Me = z.infer<typeof meSchema>;

export const otpStartResponseSchema = z.object({
  status: z.literal('code_sent'),
  message: z.string(),
  /** 再送可能になるまでの秒数（UIのクールダウン表示用。登録有無に関わらず同一） */
  resendAfterSeconds: z.number(),
});
export type OtpStartResponse = z.infer<typeof otpStartResponseSchema>;

/** 未確認ユーザーの確認完了後、サインイン用コードを追加送信した場合のみ 202 で返す */
export const otpVerifyPendingSchema = z.object({
  status: z.literal('additional_code_sent'),
  message: z.string(),
});

export const chatListSchema = z.object({
  items: z.array(chatSchema),
  nextCursor: z.string().nullable(),
});
export type ChatList = z.infer<typeof chatListSchema>;

export const messageListSchema = z.object({
  /** 時系列昇順 */
  items: z.array(chatMessageSchema),
  /** より古いメッセージを取得するためのカーソル */
  nextCursor: z.string().nullable(),
});
export type MessageList = z.infer<typeof messageListSchema>;

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN_ORIGIN',
  'NOT_FOUND',
  'CHAT_BUSY',
  'DUPLICATE_REQUEST',
  'INVALID_CODE',
  'AUTH_FLOW_EXPIRED',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'MODEL_TIMEOUT',
  'AGENT_ERROR',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
    /** RATE_LIMITED 時、再開可能時刻（ISO 8601） */
    retryAfter: z.string().optional(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// SSE（§5.2）
// ---------------------------------------------------------------------------

export const streamEventSchemas = {
  start: z.object({
    requestId: z.string(),
    chatId: z.string(),
    userMessageId: z.string(),
    assistantMessageId: z.string(),
  }),
  tool_status: z.object({
    tool: z.literal('web_search'),
    status: z.enum(['running', 'done', 'failed']),
  }),
  delta: z.object({ text: z.string() }),
  source: citationSchema,
  done: z.object({
    messageId: z.string(),
    finishReason: z.enum(['complete', 'max_tokens', 'cancelled']),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  }),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
} as const;

export type StreamEventName = keyof typeof streamEventSchemas;
export type StreamEvent = {
  [K in StreamEventName]: { event: K; data: z.infer<(typeof streamEventSchemas)[K]> };
}[StreamEventName];
