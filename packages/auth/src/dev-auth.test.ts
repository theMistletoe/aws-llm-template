import { describe, expect, it } from 'vitest';
import { DEV_AUTH_CODE, DevOtpAuthProvider, devSubFor } from './dev-auth';

describe('DevOtpAuthProvider', () => {
  it('accepts the fixed code 000000 and returns a deterministic sub', async () => {
    const p = new DevOtpAuthProvider();
    const flow = await p.start('a@example.com');
    expect(flow.flowType).toBe('signup');
    const res = await p.verify(flow, DEV_AUTH_CODE);
    expect(res).toEqual({ status: 'authenticated', user: { sub: devSubFor('a@example.com'), email: 'a@example.com' } });
    expect((await p.start('a@example.com')).flowType).toBe('signin');
  });

  it('rejects wrong codes and expires the flow after repeated failures', async () => {
    const p = new DevOtpAuthProvider();
    const flow = await p.start('b@example.com');
    const r1 = await p.verify(flow, '123456');
    expect(r1).toEqual({ status: 'invalid_code', session: 'dev:1' });
    const r2 = await p.verify({ ...flow, session: 'dev:1' }, '123456');
    expect(r2).toEqual({ status: 'invalid_code', session: 'dev:2' });
    expect(await p.verify({ ...flow, session: 'dev:2' }, '123456')).toEqual({ status: 'flow_expired' });
  });

  it('derives UUID-shaped subs', () => {
    expect(devSubFor('x@example.com')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
