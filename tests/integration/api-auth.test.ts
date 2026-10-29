import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { uniqueEmail } from '@ai-chat/test-fixtures';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TABLES } from './env';
import { Client, db } from './helpers';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('auth API over HTTP (dev-auth + MiniStack)', () => {
  it('GET /api/health', async () => {
    const res = await new Client().get('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('logs in with the fixed dev code and stores only the hashed session id', async () => {
    const c = new Client();
    const email = uniqueEmail('auth');
    const start = await c.post('/api/auth/otp/start', { email });
    expect(start.status).toBe(202);
    const flowId = c.cookies.get('__Host-auth-flow')!;
    const flow = await db.send(new GetCommand({ TableName: TABLES.session, Key: { PK: `AUTHFLOW#${sha(flowId)}` } }));
    expect(flow.Item).toMatchObject({ flowType: 'signup', email });

    const verify = await c.post('/api/auth/otp/verify', { code: '000000' });
    expect(verify.status).toBe(204);
    const sid = c.cookies.get('__Host-session')!;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session = await db.send(new GetCommand({ TableName: TABLES.session, Key: { PK: `SESSION#${sha(sid)}` } }));
    expect(session.Item).toMatchObject({ email });
    expect(session.Item!.expiresAt - session.Item!.lastSeenAt).toBe(8 * 3600);
    // 生のセッションIDはDBのどこにも保存しない
    const all = await db.send(new ScanCommand({ TableName: TABLES.session }));
    expect(JSON.stringify(all.Items)).not.toContain(sid);
    // 認証フローは一度で消費される
    const consumed = await db.send(new GetCommand({ TableName: TABLES.session, Key: { PK: `AUTHFLOW#${sha(flowId)}` } }));
    expect(consumed.Item).toBeUndefined();

    const me = await c.get('/api/auth/me');
    expect(await me.json()).toMatchObject({ email });
  });

  it('rejects a wrong code, then accepts the right one', async () => {
    const c = new Client();
    await c.post('/api/auth/otp/start', { email: uniqueEmail() });
    const wrong = await c.post('/api/auth/otp/verify', { code: '123456' });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('INVALID_CODE');
    expect((await c.post('/api/auth/otp/verify', { code: '000000' })).status).toBe(204);
  });

  it('rate limits code sending to the same email', async () => {
    const email = uniqueEmail();
    expect((await new Client().post('/api/auth/otp/start', { email })).status).toBe(202);
    const res = await new Client().post('/api/auth/otp/start', { email });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('enforces the Origin check on auth endpoints', async () => {
    const c = new Client();
    expect((await c.post('/api/auth/otp/start', { email: uniqueEmail() }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.post('/api/auth/otp/start', { email: uniqueEmail() }, { Origin: '' })).status).toBe(403);
  });

  it('logout revokes the session in DynamoDB', async () => {
    const c = new Client();
    await c.login();
    const sid = c.cookies.get('__Host-session')!;
    expect((await c.post('/api/auth/logout')).status).toBe(204);
    const row = await db.send(new GetCommand({ TableName: TABLES.session, Key: { PK: `SESSION#${sha(sid)}` } }));
    expect(row.Item?.revokedAt).toBeDefined();
    expect((await c.get('/api/auth/me', { Cookie: `__Host-session=${sid}` })).status).toBe(401);
  });

  it('treats sessions past expiresAt as invalid even before TTL deletion', async () => {
    const sid = 'x'.repeat(43);
    const now = Math.floor(Date.now() / 1000);
    await db.send(
      new PutCommand({
        TableName: TABLES.session,
        Item: { PK: `SESSION#${sha(sid)}`, userSub: 'u', email: 'e@example.test', createdAt: 'x', lastSeenAt: now - 60, expiresAt: now - 1 },
      }),
    );
    expect((await new Client().get('/api/auth/me', { Cookie: `__Host-session=${sid}` })).status).toBe(401);
  });
});
