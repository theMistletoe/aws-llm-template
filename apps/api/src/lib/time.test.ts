import { describe, expect, it } from 'vitest';
import { epochSeconds } from './time';

describe('epochSeconds', () => {
  it('truncates milliseconds', () => {
    expect(epochSeconds(new Date('2026-10-29T00:00:01.999Z'))).toBe(1793232001);
  });
});
