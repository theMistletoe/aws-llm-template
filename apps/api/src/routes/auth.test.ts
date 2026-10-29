import { describe, expect, it } from 'vitest';
import { client, createHarness } from '../testing/fakes';

describe('POST /api/auth/otp/start', () => {
  it('returns an identical response for new, existing and unconfirmed users', async () => {
    const h = createHarness();
    h.auth.startResults = ['signup', 'signin', 'signup'];
    const bodies: unknown[] = [];
    const cookieShapes: string[] = [];
    for (const email of ['new@example.com', 'existing@example.com', 'unconfirmed@example.com']) {
      const res = await client(h).post('/api/auth/otp/start', { email });
      expect(res.status).toBe(202);
      bodies.push(await res.json());
      cookieShapes.push(res.headers.getSetCookie().map((c) => c.replace(/=[^;]+;/, '=<id>;')).join('|'));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(new Set(cookieShapes).size).toBe(1);
    expect(cookieShapes[0]).toMatch(/^__Host-auth-flow=<id>; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('normalizes the email before calling the provider', async () => {
    const h = createHarness();
    await client(h).post('/api/auth/otp/start', { email: ' User@Example.COM ' });
    expect(h.auth.starts).toEqual(['user@example.com']);
  });

  it('rate limits code sending per email (60s cooldown, 5 per hour)', async () => {
    const h = createHarness();
    const c = client(h);
    expect((await c.post('/api/auth/otp/start', { email: 'a@example.com' })).status).toBe(202);
    const limited = await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string; retryAfter: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfter).toBe('2026-10-29T03:01:00.000Z');
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    // 別のメールアドレスは影響を受けない
    expect((await c.post('/api/auth/otp/start', { email: 'b@example.com' })).status).toBe(202);
    for (let i = 0; i < 4; i++) {
      h.clock.advance(61_000);
      expect((await c.post('/api/auth/otp/start', { email: 'a@example.com' })).status).toBe(202);
    }
    h.clock.advance(61_000);
    expect((await c.post('/api/auth/otp/start', { email: 'a@example.com' })).status).toBe(429);
    h.clock.advance(3600_000);
    expect((await c.post('/api/auth/otp/start', { email: 'a@example.com' })).status).toBe(202);
    expect(h.auth.starts.filter((e) => e === 'a@example.com')).toHaveLength(6);
  });

  it('validates input and requires Origin', async () => {
    const h = createHarness();
    expect((await client(h).post('/api/auth/otp/start', { email: 'nope' })).status).toBe(400);
    expect((await client(h).post('/api/auth/otp/start', 'not json')).status).toBe(400);
    const noOrigin = await h.app.request('/api/auth/otp/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN_ORIGIN');
    const evil = await client(h).post('/api/auth/otp/start', { email: 'a@example.com' }, { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
  });

  it('maps provider throttling to 429 and other failures to 503 without leaking details', async () => {
    const h = createHarness();
    h.auth.start = async () => {
      throw Object.assign(new Error('x'), { name: 'LimitExceededException' });
    };
    expect((await client(h).post('/api/auth/otp/start', { email: 'a@example.com' })).status).toBe(429);
    h.clock.advance(61_000);
    h.auth.start = async () => {
      throw Object.assign(new Error('secret detail'), { name: 'InternalErrorException' });
    };
    const res = await client(h).post('/api/auth/otp/start', { email: 'a@example.com' });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('secret detail');
  });

  it('pads the response to the configured minimum duration', async () => {
    const h = createHarness({ config: { AUTH_MIN_RESPONSE_MS: '120' } });
    const started = Date.now();
    await client(h).post('/api/auth/otp/start', { email: 'a@example.com' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});

describe('POST /api/auth/otp/verify', () => {
  it('creates a session cookie and never returns provider tokens', async () => {
    const h = createHarness();
    const c = client(h);
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    const res = await c.post('/api/auth/otp/verify', { code: '123456' });
    expect(res.status).toBe(204);
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((x) => x.startsWith('__Host-session='))).toMatch(
      /^__Host-session=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(cookies.find((x) => x.startsWith('__Host-auth-flow='))).toMatch(/Max-Age=0/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    // DBには生のセッションIDではなくハッシュのみ
    const raw = c.jar.get('__Host-session')!;
    expect([...h.sessions.sessions.keys()].some((k) => k.includes(raw))).toBe(false);
    const me = await c.get('/api/auth/me');
    expect(await me.json()).toEqual({ sub: 'sub-a@example.com', email: 'a@example.com' });
  });

  it('allows retry after a wrong code and keeps the updated provider session', async () => {
    const h = createHarness();
    const c = client(h);
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    const wrong = await c.post('/api/auth/otp/verify', { code: '000001' });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('INVALID_CODE');
    expect([...h.sessions.flows.values()][0]!.cognitoSession).toBe('retry-session');
    expect((await c.post('/api/auth/otp/verify', { code: '123456' })).status).toBe(204);
  });

  it('cannot reuse a consumed flow', async () => {
    const h = createHarness();
    const c = client(h);
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    const flowCookie = c.jar.get('__Host-auth-flow')!;
    expect((await c.post('/api/auth/otp/verify', { code: '123456' })).status).toBe(204);
    const replay = await c.post('/api/auth/otp/verify', { code: '123456' }, { Cookie: `__Host-auth-flow=${flowCookie}` });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('AUTH_FLOW_EXPIRED');
  });

  it('expires the flow after 5 minutes', async () => {
    const h = createHarness();
    const c = client(h);
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    h.clock.advance(301_000);
    const res = await c.post('/api/auth/otp/verify', { code: '123456' });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_FLOW_EXPIRED');
    expect(res.headers.getSetCookie().join()).toMatch(/__Host-auth-flow=; Max-Age=0/);
  });

  it('restarts when the provider reports an expired flow or token verification fails', async () => {
    const h = createHarness();
    const c = client(h);
    h.auth.verifyImpl = async () => ({ status: 'flow_expired' });
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    expect(((await (await c.post('/api/auth/otp/verify', { code: '123456' })).json()) as { error: { code: string } }).error.code).toBe(
      'AUTH_FLOW_EXPIRED',
    );
    h.clock.advance(61_000);
    h.auth.verifyImpl = async () => {
      throw new Error('JwtInvalidSignatureError');
    };
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    const res = await c.post('/api/auth/otp/verify', { code: '123456' });
    expect(res.status).toBe(400);
    expect(c.jar.has('__Host-session')).toBe(false);
  });

  it('handles the additional sign-in code path', async () => {
    const h = createHarness();
    const c = client(h);
    let calls = 0;
    h.auth.verifyImpl = async (flow) => {
      calls++;
      if (calls === 1) return { status: 'additional_code_sent', next: { flowType: 'signin', email: flow.email, session: 'S' } };
      return { status: 'authenticated', user: { sub: 'u1', email: flow.email } };
    };
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    const first = await c.post('/api/auth/otp/verify', { code: '111111' });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: 'additional_code_sent' });
    expect((await c.post('/api/auth/otp/verify', { code: '222222' })).status).toBe(204);
  });

  it('rejects missing flow cookie and malformed codes', async () => {
    const h = createHarness();
    expect((await client(h).post('/api/auth/otp/verify', { code: '123456' })).status).toBe(400);
    const c = client(h);
    await c.post('/api/auth/otp/start', { email: 'a@example.com' });
    expect((await c.post('/api/auth/otp/verify', { code: '12ab56' })).status).toBe(400);
  });

  it('revokes a pre-existing session on login (session fixation)', async () => {
    const h = createHarness();
    const c = client(h);
    await c.login('a@example.com');
    const first = c.jar.get('__Host-session')!;
    h.clock.advance(61_000);
    await c.login('a@example.com');
    expect(c.jar.get('__Host-session')).not.toBe(first);
    const old = await client(h).get('/api/auth/me', { Cookie: `__Host-session=${first}` });
    expect(old.status).toBe(401);
  });
});

describe('BFF session', () => {
  it('requires a valid session for /api/auth/me and /api/v1/*', async () => {
    const h = createHarness();
    expect((await client(h).get('/api/auth/me')).status).toBe(401);
    expect((await client(h).get('/api/v1/chats')).status).toBe(401);
    expect((await client(h).get('/api/v1/chats', { Cookie: '__Host-session=garbage' })).status).toBe(401);
    expect((await client(h).get('/api/v1/chats', { Cookie: `__Host-session=${'a'.repeat(43)}` })).status).toBe(401);
  });

  it('expires after 30 minutes of inactivity and touches lastSeenAt periodically', async () => {
    const h = createHarness();
    const c = client(h);
    await c.login();
    h.clock.advance(59_000);
    await c.get('/api/auth/me');
    expect(h.sessions.touches).toHaveLength(0);
    h.clock.advance(2_000);
    await c.get('/api/auth/me');
    expect(h.sessions.touches).toHaveLength(1);
    h.clock.advance(29 * 60_000);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    h.clock.advance(30 * 60_000);
    const res = await c.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join()).toMatch(/__Host-session=; Max-Age=0/);
  });

  it('expires after the 8 hour absolute lifetime even when active', async () => {
    const h = createHarness();
    const c = client(h);
    await c.login();
    for (let i = 0; i < 16; i++) {
      h.clock.advance(29 * 60_000);
      await c.get('/api/auth/me');
    }
    h.clock.advance(29 * 60_000);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const h = createHarness();
    const c = client(h);
    await c.login();
    const sid = c.jar.get('__Host-session')!;
    expect((await c.post('/api/auth/logout')).status).toBe(204);
    expect((await client(h).get('/api/auth/me', { Cookie: `__Host-session=${sid}` })).status).toBe(401);
  });

  it('logout requires the Origin check', async () => {
    const h = createHarness();
    const c = client(h);
    await c.login();
    expect((await c.post('/api/auth/logout', {}, { Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('misc', () => {
  it('health check exposes no configuration', async () => {
    const h = createHarness();
    const res = await h.app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('X-Request-Id')).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const h = createHarness();
    const res = await h.app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('rejects oversized bodies', async () => {
    const h = createHarness();
    const res = await client(h).post('/api/auth/otp/start', { email: 'a'.repeat(70_000) });
    expect(res.status).toBe(413);
  });
});
