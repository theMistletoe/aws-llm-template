import type { ErrorCode } from '@ai-chat/contracts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** APIの業務エラー。エラーハンドラが §5.1 の ApiError 形式に変換する */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      retryAfter?: string;
      details?: Array<{ path: string; message: string }>;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  unauthenticated: () => new AppError('UNAUTHENTICATED', 401, 'ログインが必要です'),
  forbiddenOrigin: () => new AppError('FORBIDDEN_ORIGIN', 403, '許可されていないリクエストです'),
  notFound: () => new AppError('NOT_FOUND', 404, '見つかりません'),
  chatBusy: () =>
    new AppError('CHAT_BUSY', 409, '応答を生成中です。生成を停止してから操作してください', { retryable: true }),
  duplicateRequest: () => new AppError('DUPLICATE_REQUEST', 409, 'このリクエストは既に処理されています'),
  quotaExceeded: (retryAfter: string) =>
    new AppError('QUOTA_EXCEEDED', 429, '利用上限に達しました', { retryable: true, retryAfter }),
  rateLimited: (retryAfter: string) =>
    new AppError('RATE_LIMITED', 429, 'しばらく待ってから再度お試しください', { retryable: true, retryAfter }),
  invalidCode: () => new AppError('INVALID_CODE', 400, '確認コードが正しくありません', { retryable: true }),
  authFlowExpired: () =>
    new AppError('AUTH_FLOW_EXPIRED', 400, 'コードの有効期限が切れました。もう一度コードを送信してください'),
  validation: (details?: Array<{ path: string; message: string }>) =>
    new AppError('VALIDATION_ERROR', 400, '入力内容を確認してください', details ? { details } : {}),
  payloadTooLarge: () => new AppError('VALIDATION_ERROR', 413, 'リクエストが大きすぎます'),
  authUnavailable: () =>
    new AppError('INTERNAL_ERROR', 503, 'コードを送信できませんでした。時間をおいて再度お試しください', {
      retryable: true,
    }),
  internal: () => new AppError('INTERNAL_ERROR', 500, 'サーバーエラーが発生しました', { retryable: true }),
};
