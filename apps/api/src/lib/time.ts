/**
 * クォータの日付・時間境界（§7.2）。既定はJST（Asia/Tokyo）で、IANAタイムゾーン名で変更可能。
 */

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** 指定タイムゾーンのUTCからのオフセット（ミリ秒） */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** タイムゾーン上の壁時計時刻をUTCのDateに変換する */
function fromZoned(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = guess - offsetMs(new Date(guess), timeZone);
  // DSTを跨ぐ場合に備えて1回補正する
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function hourKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}`;
}

/** 次の日次クォータのリセット時刻 */
export function nextDayStart(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return fromZoned(p.year, p.month, p.day + 1, 0, timeZone);
}

/** 次の時間別クォータのリセット時刻 */
export function nextHourStart(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return fromZoned(p.year, p.month, p.day, p.hour + 1, timeZone);
}

export const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
