import { describe, expect, it } from 'vitest';
import { evaluateFunction, rewriteUri } from '../lib/spa-rewrite';

describe('SPA rewrite (CloudFront Function generated from TypeScript)', () => {
  it.each([
    ['/', '/index.html'],
    ['/chat/01JBQ7Z8X9Y0ABCDEFGHJKMNPQ', '/index.html'],
    ['/login', '/index.html'],
    ['/settings/', '/index.html'],
    ['/assets/index-abc.js', '/assets/index-abc.js'],
    ['/favicon.svg', '/favicon.svg'],
    ['/api/health', '/api/health'],
    ['/api/v1/chats', '/api/v1/chats'],
    ['/api', '/api'],
  ])('%s -> %s', (input, expected) => {
    expect(rewriteUri(input)).toBe(expected);
    expect(evaluateFunction()({ request: { uri: input } }).uri).toBe(expected);
  });
});
