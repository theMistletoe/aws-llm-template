import { describe, expect, it } from 'vitest';
import { createFakeClock, fixedReply, fixedSearchAnswer, uniqueEmail, wantsSearch } from './index';

describe('test fixtures', () => {
  it('detects search intent', () => {
    expect(wantsSearch('最新のAWSニュースは？')).toBe(true);
    expect(wantsSearch('Latest news')).toBe(true);
    expect(wantsSearch('こんにちは')).toBe(false);
  });

  it('builds deterministic replies', () => {
    expect(fixedReply('こんにちは [[slow]]')).toContain('「こんにちは」');
    expect(fixedSearchAnswer([{ title: 'A' }])).toContain('1. A');
    expect(fixedSearchAnswer([])).toContain('未確認');
  });

  it('creates unique emails and a controllable clock', () => {
    expect(uniqueEmail()).not.toBe(uniqueEmail());
    const clock = createFakeClock('2026-01-01T00:00:00Z');
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });
});
