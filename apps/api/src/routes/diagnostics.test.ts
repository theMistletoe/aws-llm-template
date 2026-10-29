import { describe, expect, it } from 'vitest';
import { client, createHarness } from '../testing/fakes';

describe('diagnostics stream (PoC only)', () => {
  it('is not registered by default', async () => {
    const h = createHarness();
    const c = client(h);
    await c.login();
    expect((await c.get('/api/v1/diagnostics/stream?seconds=1')).status).toBe(404);
  });

  it('streams only heartbeats then done, and requires a session', async () => {
    const h = createHarness({ config: { DIAGNOSTICS_ENABLED: 'true', HEARTBEAT_INTERVAL_MS: '20' } });
    expect((await client(h).get('/api/v1/diagnostics/stream?seconds=1')).status).toBe(401);
    const c = client(h);
    await c.login();
    const res = await c.get('/api/v1/diagnostics/stream?seconds=1');
    const text = await res.text();
    expect(text.startsWith('event: start')).toBe(true);
    expect(text.match(/^: ping$/gm)!.length).toBeGreaterThan(10);
    expect(text).toContain('event: done');
    expect((await c.get('/api/v1/diagnostics/stream?seconds=999')).status).toBe(400);
  });
});
