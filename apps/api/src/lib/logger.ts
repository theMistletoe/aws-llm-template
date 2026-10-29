export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * ログに出してはいけないキー（§6.7, §13）。本文・トークン・Cookie・認証コード・メールアドレス等。
 * 呼び出し側で渡さないのが原則で、これは誤って渡した場合の多層防御。
 */
const FORBIDDEN_KEY =
  /^(content|text|message|prompt|query|snippet|email|code|otp|token|idtoken|accesstoken|refreshtoken|cookie|cookies|session|cognitosession|authorization|password|secret|clientsecret|body|context)$/i;

export function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(key)) {
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      // エラーメッセージには入力値が含まれ得るため、分類名のみ記録する
      out[key] = value.name;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitize(value as LogFields);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createLogger(
  level: LogLevel = 'info',
  base: LogFields = {},
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const write = (lvl: LogLevel, event: string, fields?: LogFields) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const record = { timestamp: new Date().toISOString(), level: lvl, event, ...sanitize({ ...base, ...fields }) };
    sink(JSON.stringify(record));
  };
  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
