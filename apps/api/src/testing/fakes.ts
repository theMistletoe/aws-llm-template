import type { AgentEvent, AgentInvokeRequest, AgentRunner } from '@ai-chat/agent-contracts';
import type { AuthFlowState, OtpAuthProvider, VerifyResult } from '@ai-chat/auth';
import { loadApiConfig, type ApiConfig } from '@ai-chat/config';
import { createFakeClock, type FakeClock } from '@ai-chat/test-fixtures';
import { monotonicFactory } from 'ulid';
import { createApp } from '../app';
import type { AppDeps, ChatStore, SessionStore } from '../deps';
import { silentLogger, type Logger } from '../lib/logger';
import {
  StartRunConflict,
  decodeCursor,
  encodeCursor,
  keys,
  type ChatMetaItem,
  type FinishRunParams,
  type MessageItem,
  type RunItem,
  type StartRunFailure,
  type StartRunParams,
  type TitleSource,
} from '../repositories/chat-repository';
import type { AuthFlowItem, OtpRateItem, SessionItem } from '../repositories/session-repository';

const clone = <T>(v: T): T => structuredClone(v);

/** ChatRepository と同じ条件で振る舞うインメモリ実装（ユニットテスト用） */
export class FakeChatStore implements ChatStore {
  metas = new Map<string, ChatMetaItem>();
  messages = new Map<string, MessageItem>();
  runs = new Map<string, RunItem>();

  async createChat(p: { chatId: string; ownerSub: string; title: string; titleSource: TitleSource; now: Date }) {
    if (this.metas.has(p.chatId)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    const iso = p.now.toISOString();
    const item: ChatMetaItem = {
      PK: keys.chat(p.chatId),
      SK: 'META',
      type: 'chat',
      chatId: p.chatId,
      ownerSub: p.ownerSub,
      title: p.title,
      titleSource: p.titleSource,
      createdAt: iso,
      updatedAt: iso,
      GSI1PK: keys.user(p.ownerSub),
      GSI1SK: keys.gsi1Sk(iso, p.chatId),
    };
    this.metas.set(p.chatId, item);
    return clone(item);
  }

  async getMeta(chatId: string) {
    const m = this.metas.get(chatId);
    return m ? clone(m) : undefined;
  }

  async getRun(chatId: string, requestId: string) {
    const r = this.runs.get(`${chatId}/${requestId}`);
    return r ? clone(r) : undefined;
  }

  async listChats(ownerSub: string, limit: number, cursor?: string) {
    const gsi1pk = keys.user(ownerSub);
    const start = decodeCursor(cursor, { GSI1PK: gsi1pk });
    const all = [...this.metas.values()]
      .filter((m) => m.GSI1PK === gsi1pk)
      .sort((a, b) => (a.GSI1SK! < b.GSI1SK! ? 1 : -1));
    const from = start ? all.findIndex((m) => m.GSI1SK === start.GSI1SK) + 1 : 0;
    const page = all.slice(from, from + limit);
    const last = page.at(-1);
    const more = from + limit < all.length;
    return {
      items: clone(page.filter((m) => !m.deletedAt)),
      nextCursor: more && last ? encodeCursor({ GSI1PK: gsi1pk, GSI1SK: last.GSI1SK!, PK: last.PK, SK: 'META' }) : null,
    };
  }

  async updateTitle(chatId: string, ownerSub: string, title: string, now: Date) {
    const m = this.metas.get(chatId);
    if (!m || m.ownerSub !== ownerSub || m.deletedAt) return undefined;
    Object.assign(m, { title, titleSource: 'user', updatedAt: now.toISOString(), GSI1SK: keys.gsi1Sk(now.toISOString(), chatId) });
    return clone(m);
  }

  async softDelete(chatId: string, ownerSub: string, now: Date) {
    const m = this.metas.get(chatId);
    if (!m || m.ownerSub !== ownerSub || m.deletedAt) return 'not_found' as const;
    if (m.activeRunId && (m.lockExpiresAt ?? 0) >= now.getTime()) return 'busy' as const;
    m.deletedAt = now.toISOString();
    delete m.GSI1PK;
    delete m.GSI1SK;
    return 'deleted' as const;
  }

  async purgeChatItems(chatId: string) {
    let n = 0;
    for (const [k, v] of this.messages) if (v.chatId === chatId && this.messages.delete(k)) n++;
    for (const k of this.runs.keys()) if (k.startsWith(`${chatId}/`) && this.runs.delete(k)) n++;
    return n;
  }

  private chatMessages(chatId: string) {
    return [...this.messages.values()].filter((m) => m.chatId === chatId).sort((a, b) => (a.SK < b.SK ? -1 : 1));
  }

  async listMessages(chatId: string, limit: number, cursor?: string) {
    const pk = keys.chat(chatId);
    const start = decodeCursor(cursor, { PK: pk });
    const desc = this.chatMessages(chatId).reverse();
    const from = start ? desc.findIndex((m) => m.SK === start.SK) + 1 : 0;
    const page = desc.slice(from, from + limit);
    const more = from + limit < desc.length;
    const last = page.at(-1);
    return { items: clone(page.reverse()), nextCursor: more && last ? encodeCursor({ PK: pk, SK: last.SK }) : null };
  }

  async recentCompletedMessages(chatId: string, max: number) {
    if (max <= 0) return [];
    return clone(
      this.chatMessages(chatId)
        .reverse()
        .slice(0, max + 10)
        .filter((m) => m.status === 'completed' && m.content.trim().length > 0)
        .slice(0, max)
        .reverse(),
    );
  }

  async startRun(p: StartRunParams) {
    const reasons: StartRunFailure[] = [];
    if (this.runs.has(`${p.chatId}/${p.requestId}`)) reasons.push('duplicate');
    const m = this.metas.get(p.chatId);
    if (!m || m.ownerSub !== p.ownerSub || m.deletedAt || (m.activeRunId && (m.lockExpiresAt ?? 0) >= p.now.getTime())) {
      reasons.push('busy_or_gone');
    }
    if (reasons.length > 0) throw new StartRunConflict(reasons);
    const iso = p.now.toISOString();
    const pk = keys.chat(p.chatId);
    this.runs.set(`${p.chatId}/${p.requestId}`, {
      PK: pk,
      SK: keys.run(p.requestId),
      type: 'run',
      requestId: p.requestId,
      userMessageId: p.userMessageId,
      assistantMessageId: p.assistantMessageId,
      status: 'running',
      startedAt: iso,
    });
    const base = { PK: pk, type: 'message' as const, chatId: p.chatId, createdAt: iso, requestId: p.requestId };
    this.messages.set(p.userMessageId, {
      ...base,
      SK: keys.message(p.userMessageId),
      messageId: p.userMessageId,
      role: 'user',
      content: p.content,
      status: 'completed',
    });
    this.messages.set(p.assistantMessageId, {
      ...base,
      SK: keys.message(p.assistantMessageId),
      messageId: p.assistantMessageId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      modelId: p.modelId,
    });
    Object.assign(m!, {
      activeRunId: p.requestId,
      lockExpiresAt: p.lockExpiresAt,
      updatedAt: iso,
      GSI1SK: keys.gsi1Sk(iso, p.chatId),
      ...(p.autoTitle !== undefined ? { title: p.autoTitle, titleSource: 'auto' } : {}),
    });
  }

  finishCalls: FinishRunParams[] = [];

  async finishRun(p: FinishRunParams) {
    this.finishCalls.push(clone(p));
    const msg = this.messages.get(p.assistantMessageId);
    const m = this.metas.get(p.chatId);
    let committed = false;
    if (msg && msg.status === 'streaming' && m?.activeRunId === p.requestId) {
      Object.assign(msg, {
        content: p.content,
        status: p.status,
        usage: p.usage,
        ...(p.citations.length > 0 ? { citations: p.citations } : {}),
        ...(p.searched ? { searchedAt: p.now.toISOString() } : {}),
        ...(p.searchFailed ? { searchFailed: true } : {}),
      });
      const run = this.runs.get(`${p.chatId}/${p.requestId}`)!;
      Object.assign(run, { status: p.status, finishedAt: p.now.toISOString() });
      delete m.activeRunId;
      delete m.lockExpiresAt;
      committed = true;
    }
    return committed;
  }

  async recoverStaleRun(meta: ChatMetaItem, now: Date) {
    const m = this.metas.get(meta.chatId);
    if (!m?.activeRunId || (m.lockExpiresAt ?? 0) >= now.getTime()) return clone(m ?? meta);
    const run = this.runs.get(`${m.chatId}/${m.activeRunId}`);
    if (run && run.status === 'running') {
      run.status = 'interrupted';
      run.finishedAt = now.toISOString();
      const msg = this.messages.get(run.assistantMessageId);
      if (msg?.status === 'streaming') msg.status = 'interrupted';
    }
    delete m.activeRunId;
    delete m.lockExpiresAt;
    return clone(m);
  }
}

/** SessionRepository と同じ条件で振る舞うインメモリ実装 */
export class FakeSessionStore implements SessionStore {
  sessions = new Map<string, SessionItem>();
  flows = new Map<string, AuthFlowItem>();
  rates = new Map<string, OtpRateItem>();

  async putSession(item: Omit<SessionItem, 'PK'> & { sessionHash: string }) {
    const { sessionHash, ...rest } = item;
    this.sessions.set(sessionHash, { PK: `SESSION#${sessionHash}`, ...rest });
  }
  async getSession(hash: string) {
    const s = this.sessions.get(hash);
    return s ? clone(s) : undefined;
  }
  touches: number[] = [];
  async touchSession(hash: string, nowSec: number) {
    const s = this.sessions.get(hash);
    if (s && !s.revokedAt) {
      s.lastSeenAt = nowSec;
      this.touches.push(nowSec);
    }
  }
  async revokeSession(hash: string, now: Date) {
    const s = this.sessions.get(hash);
    if (s) s.revokedAt = now.toISOString();
  }
  async putAuthFlow(hash: string, item: Omit<AuthFlowItem, 'PK'>, mustNotExist = true) {
    if (mustNotExist && this.flows.has(hash)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    this.flows.set(hash, { ...clone(item), PK: `AUTHFLOW#${hash}` });
  }
  async consumeAuthFlow(hash: string, nowSec: number) {
    const f = this.flows.get(hash);
    if (!f || f.expiresAt <= nowSec) return undefined;
    this.flows.delete(hash);
    return clone(f);
  }
  async deleteAuthFlow(hash: string) {
    this.flows.delete(hash);
  }
  async reserveOtpSend(emailHash: string, nowSec: number, cooldownSeconds: number, maxPerHour: number) {
    const current = this.rates.get(emailHash);
    const fresh = current && current.expiresAt > nowSec ? current : undefined;
    if (fresh && nowSec - fresh.lastSentAt < cooldownSeconds) return { ok: false as const, retryAt: fresh.lastSentAt + cooldownSeconds };
    let windowStart = fresh?.windowStart ?? nowSec;
    let count = fresh?.sentCountInHour ?? 0;
    if (nowSec - windowStart >= 3600) {
      windowStart = nowSec;
      count = 0;
    }
    if (count >= maxPerHour) return { ok: false as const, retryAt: windowStart + 3600 };
    this.rates.set(emailHash, {
      PK: `OTPRATE#${emailHash}`,
      lastSentAt: nowSec,
      windowStart,
      sentCountInHour: count + 1,
      expiresAt: Math.max(windowStart + 3600, nowSec + cooldownSeconds),
      version: (current?.version ?? 0) + 1,
    });
    return { ok: true as const };
  }
}

/** シナリオを差し替えられるAgentRunner */
export class ScriptedAgentRunner implements AgentRunner {
  requests: AgentInvokeRequest[] = [];
  stopped: Array<{ chatId: string; userSub: string }> = [];
  constructor(public script: (req: AgentInvokeRequest, signal: AbortSignal) => AsyncIterable<AgentEvent> = defaultScript) {}
  run(request: AgentInvokeRequest, signal: AbortSignal) {
    this.requests.push(request);
    return this.script(request, signal);
  }
  async stopSession(params: { chatId: string; userSub: string }) {
    this.stopped.push(params);
  }
}

export async function* defaultScript(): AsyncGenerator<AgentEvent> {
  yield { type: 'delta', text: 'こんにちは' };
  yield { type: 'delta', text: '、世界' };
  yield { type: 'usage', inputTokens: 10, outputTokens: 5, searchCalls: 0 };
  yield { type: 'done', reason: 'complete' };
}

/** フロー種別を外から制御できる認証プロバイダ（新規/既存/未確認の分岐テスト用） */
export class FakeAuthProvider implements OtpAuthProvider {
  readonly kind = 'cognito' as const;
  startResults: AuthFlowState['flowType'][] = [];
  verifyImpl: (flow: AuthFlowState, code: string) => Promise<VerifyResult> = async (flow, code) =>
    code === '123456'
      ? { status: 'authenticated', user: { sub: `sub-${flow.email}`, email: flow.email } }
      : { status: 'invalid_code', session: 'retry-session' };
  starts: string[] = [];
  async start(email: string): Promise<AuthFlowState> {
    this.starts.push(email);
    const flowType = this.startResults.shift() ?? 'signup';
    return { flowType, email, ...(flowType === 'signin' ? { session: 'cognito-session' } : {}) };
  }
  verify(flow: AuthFlowState, code: string) {
    return this.verifyImpl(flow, code);
  }
}

export const TEST_ORIGIN = 'http://localhost:5173';

export function testConfig(overrides: Record<string, string> = {}): ApiConfig {
  return loadApiConfig({
    APP_MODE: 'local',
    APP_ORIGIN: TEST_ORIGIN,
    AWS_ENDPOINT_URL: 'http://localhost:4566',
    DATA_TABLE_NAME: 'data',
    SESSION_TABLE_NAME: 'session',
    AUTH_BACKEND: 'dev-auth',
    AGENT_BACKEND: 'local-strands',
    MODEL_ID: 'test-model',
    ...overrides,
  });
}

export type TestHarness = {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  clock: FakeClock;
  chats: FakeChatStore;
  sessions: FakeSessionStore;
  agent: ScriptedAgentRunner;
  auth: FakeAuthProvider;
};

export function createHarness(options: { config?: Record<string, string>; logger?: Logger } = {}): TestHarness {
  const clock = createFakeClock('2026-10-29T03:00:00.000Z');
  const chats = new FakeChatStore();
  const sessions = new FakeSessionStore();
  const agent = new ScriptedAgentRunner();
  const auth = new FakeAuthProvider();
  const ulid = monotonicFactory();
  const deps: AppDeps = {
    config: testConfig(options.config),
    clock,
    newId: () => ulid(clock.now().getTime()),
    chats,
    sessions,
    auth,
    agent,
    logger: options.logger ?? silentLogger,
    resolveAppOrigin: async () => TEST_ORIGIN,
  };
  return { app: createApp(deps), deps, clock, chats, sessions, agent, auth };
}

/** テスト用HTTPクライアント（Cookieを保持し、状態変更時はOriginを付与する） */
export function client(h: TestHarness) {
  const jar = new Map<string, string>();
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await h.app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { Origin: TEST_ORIGIN } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [name, value] = pair!.split('=');
      if (/Max-Age=0/i.test(sc) || value === '') jar.delete(name!);
      else jar.set(name!, value!);
    }
    return res;
  };
  return {
    jar,
    get: (path: string, headers?: Record<string, string>) => request('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => request('POST', path, body ?? {}, headers),
    patch: (path: string, body: unknown) => request('PATCH', path, body),
    del: (path: string) => request('DELETE', path),
    async login(email = 'user@example.com', code = '123456') {
      const s = await request('POST', '/api/auth/otp/start', { email });
      if (s.status !== 202) throw new Error(`start failed ${s.status}`);
      const v = await request('POST', '/api/auth/otp/verify', { code });
      if (v.status !== 204) throw new Error(`verify failed ${v.status}`);
    },
  };
}
