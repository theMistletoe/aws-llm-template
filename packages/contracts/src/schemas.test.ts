import { describe, expect, it } from 'vitest';
import {
  createChatInputSchema,
  otpStartInputSchema,
  otpVerifyInputSchema,
  sendMessageInputSchema,
  updateChatInputSchema,
} from './schemas';
import { deriveTitle, isSafeHttpUrl } from './util';

const uuidv7 = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('sendMessageInputSchema', () => {
  it('accepts 1..4000 characters', () => {
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: 'a' }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: 'あ'.repeat(4000) }).success).toBe(true);
  });

  it('rejects empty, whitespace-only, too long and unknown fields', () => {
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: '' }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: '  \n ' }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: 'a'.repeat(4001) }).success).toBe(false);
    expect(
      sendMessageInputSchema.safeParse({ requestId: uuidv7, content: 'a', userId: 'someone-else' }).success,
    ).toBe(false);
  });

  it('counts surrogate pairs as one character but enforces the byte limit', () => {
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: '🙂'.repeat(4000) }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({ requestId: uuidv7, content: '🙂'.repeat(4001) }).success).toBe(false);
  });

  it('requires a UUIDv7 requestId', () => {
    expect(
      sendMessageInputSchema.safeParse({ requestId: '9b2f2b6e-3f2a-4b8e-9f3a-2a1b3c4d5e6f', content: 'a' }).success,
    ).toBe(false);
    expect(sendMessageInputSchema.safeParse({ requestId: 'x', content: 'a' }).success).toBe(false);
  });
});

describe('auth inputs', () => {
  it('normalizes email', () => {
    expect(otpStartInputSchema.parse({ email: '  User@Example.COM ' })).toEqual({ email: 'user@example.com' });
    expect(otpStartInputSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('accepts 6-8 digit codes only', () => {
    expect(otpVerifyInputSchema.safeParse({ code: '000000' }).success).toBe(true);
    expect(otpVerifyInputSchema.safeParse({ code: '12345678' }).success).toBe(true);
    expect(otpVerifyInputSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(otpVerifyInputSchema.safeParse({ code: 'abcdef' }).success).toBe(false);
  });
});

describe('chat inputs', () => {
  it('validates titles', () => {
    expect(createChatInputSchema.parse({})).toEqual({});
    expect(updateChatInputSchema.parse({ title: '  名前 ' })).toEqual({ title: '名前' });
    expect(updateChatInputSchema.safeParse({ title: ' ' }).success).toBe(false);
    expect(updateChatInputSchema.safeParse({ title: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('util', () => {
  it('allows only http(s) URLs', () => {
    expect(isSafeHttpUrl('https://docs.aws.amazon.com/x')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeHttpUrl('//example.com')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });

  it('derives titles from the first 30 characters', () => {
    expect(deriveTitle('  こんにちは\n世界  ')).toBe('こんにちは 世界');
    expect(deriveTitle('あ'.repeat(40))).toBe('あ'.repeat(30));
    expect(deriveTitle('🙂'.repeat(31))).toBe('🙂'.repeat(30));
    expect(deriveTitle('   ')).toBe('新しいチャット');
  });
});
