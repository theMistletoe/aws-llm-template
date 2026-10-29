import { describe, expect, it } from 'vitest';
import { createLogger, sanitize } from './logger';

describe('structured logger', () => {
  it('writes JSON lines with level filtering', () => {
    const lines: string[] = [];
    const log = createLogger('info', { service: 'api' }, (l) => lines.push(l));
    log.debug('hidden');
    log.child({ requestId: 'r1' }).info('http_request', { status: 200, latencyMs: 5 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', event: 'http_request', service: 'api', requestId: 'r1', status: 200 });
  });

  it('never writes prompts, tokens, cookies, codes or email addresses', () => {
    const out = sanitize({
      content: 'secret prompt',
      email: 'a@example.com',
      code: '123456',
      idToken: 'eyJ',
      cookie: 'x',
      nested: { authorization: 'Bearer x', ok: 1 },
      err: new Error('contains a@example.com'),
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/secret prompt|a@example\.com|123456|eyJ|Bearer/);
    expect(out.nested).toEqual({ authorization: '[redacted]', ok: 1 });
    expect(out.err).toBe('Error');
  });
});
