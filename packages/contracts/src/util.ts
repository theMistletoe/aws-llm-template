import { LIMITS, DEFAULT_CHAT_TITLE } from './schemas';

/** 引用URLとして表示してよいか（http/httpsのみ。§3 UI要件8, §6.7） */
export function isSafeHttpUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 最初のユーザー発言から自動タイトルを作る（先頭30文字、LLMは呼ばない。§3 UI要件12） */
export function deriveTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_CHAT_TITLE;
  return [...normalized].slice(0, LIMITS.autoTitleChars).join('');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
