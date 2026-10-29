import { describe, expect, it } from 'vitest';
import { agentInvokeRequestSchema, decodeAgentEvent, encodeAgentEvent, runtimeSessionIdFor } from './index';

const validRequest = {
  version: 1,
  requestId: '01890a5d-ac96-774b-bcce-b302099a8057',
  chatId: '01JBQ7Z8X9Y0ABCDEFGHJKMNPQ',
  userSub: 'user-sub',
  message: 'hello',
  context: [{ role: 'user', content: 'a' }],
  options: { allowWebSearch: true, maxToolCalls: 3, maxOutputTokens: 2048 },
};

describe('agentInvokeRequestSchema', () => {
  it('accepts a valid request', () => {
    expect(agentInvokeRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects out-of-contract values', () => {
    expect(agentInvokeRequestSchema.safeParse({ ...validRequest, version: 2 }).success).toBe(false);
    expect(
      agentInvokeRequestSchema.safeParse({ ...validRequest, options: { ...validRequest.options, maxToolCalls: 4 } })
        .success,
    ).toBe(false);
    expect(
      agentInvokeRequestSchema.safeParse({ ...validRequest, context: Array(21).fill({ role: 'user', content: 'a' }) })
        .success,
    ).toBe(false);
    expect(agentInvokeRequestSchema.safeParse({ ...validRequest, extra: true }).success).toBe(false);
  });
});

describe('runtimeSessionIdFor', () => {
  it('is deterministic per chat and user and within AgentCore limits', () => {
    const id = runtimeSessionIdFor('01JBQ7Z8X9Y0ABCDEFGHJKMNPQ', 'user-a');
    expect(id).toMatch(/^chat-01JBQ7Z8X9Y0ABCDEFGHJKMNPQ-[0-9a-f]{16}$/);
    expect(id).toHaveLength(48);
    expect(runtimeSessionIdFor('01JBQ7Z8X9Y0ABCDEFGHJKMNPQ', 'user-a')).toBe(id);
    expect(runtimeSessionIdFor('01JBQ7Z8X9Y0ABCDEFGHJKMNPQ', 'user-b')).not.toBe(id);
  });

  it('rejects ids that would violate the length constraint', () => {
    expect(() => runtimeSessionIdFor('a', 'u')).toThrow();
  });
});

describe('agent event wire format', () => {
  it('round-trips events', () => {
    const frame = encodeAgentEvent({ type: 'delta', text: 'こんにちは' });
    expect(frame).toBe('event: delta\ndata: {"type":"delta","text":"こんにちは"}\n\n');
    expect(decodeAgentEvent('{"type":"usage","inputTokens":1,"outputTokens":2,"searchCalls":0}')).toEqual({
      type: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      searchCalls: 0,
    });
  });

  it('rejects malformed events', () => {
    expect(decodeAgentEvent('nope')).toBeNull();
    expect(decodeAgentEvent('{"type":"tool_status","tool":"shell","status":"running"}')).toBeNull();
  });
});
