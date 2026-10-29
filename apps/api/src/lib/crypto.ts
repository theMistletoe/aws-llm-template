import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 256bitの乱数トークン（base64url, 43文字） */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

