import { describe, expect, it } from 'vitest';
import { dayKey, hourKey, nextDayStart, nextHourStart } from './time';

describe('quota boundaries', () => {
  it('uses JST day and hour keys', () => {
    const justBeforeMidnightJst = new Date('2026-10-29T14:59:59Z');
    expect(dayKey(justBeforeMidnightJst, 'Asia/Tokyo')).toBe('2026-10-29');
    expect(hourKey(justBeforeMidnightJst, 'Asia/Tokyo')).toBe('2026-10-29T23');
    const midnightJst = new Date('2026-10-29T15:00:00Z');
    expect(dayKey(midnightJst, 'Asia/Tokyo')).toBe('2026-10-30');
    expect(hourKey(midnightJst, 'Asia/Tokyo')).toBe('2026-10-30T00');
  });

  it('computes the next reset times', () => {
    const now = new Date('2026-10-29T14:59:59Z');
    expect(nextDayStart(now, 'Asia/Tokyo').toISOString()).toBe('2026-10-29T15:00:00.000Z');
    expect(nextHourStart(now, 'Asia/Tokyo').toISOString()).toBe('2026-10-29T15:00:00.000Z');
    expect(nextDayStart(new Date('2026-12-31T15:30:00Z'), 'Asia/Tokyo').toISOString()).toBe('2027-01-01T15:00:00.000Z');
  });

  it('supports other time zones including DST transitions', () => {
    expect(dayKey(new Date('2026-10-29T03:00:00Z'), 'UTC')).toBe('2026-10-29');
    // America/New_York: 2026-11-01 にDST終了（UTC-4 → UTC-5）
    expect(nextDayStart(new Date('2026-10-31T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(nextDayStart(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });
});
