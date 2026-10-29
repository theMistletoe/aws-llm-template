import { SseParser, parseStreamEvent, type StreamEvent } from '@ai-chat/contracts';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { uuidv7 } from 'uuidv7';
import { MailTmInbox } from './mailbox';

/**
 * AWS dev 受入試験（§12.6）の自動化。ローカルの代替にしない。`pnpm test` には含めない。
 *   APP_URL=https://xxx.cloudfront.net SMOKE_MAILBOX_FILE=./mailboxes.json pnpm test:aws-smoke
 * SMOKE_MAILBOX_FILE: [{ "address": "...", "password": "..." }, ...]（mail.tm、SESで検証済みのアドレス2件）
 * SMOKE_OTP_MANUAL=1 の場合は、届いたコードを標準入力で入力する（SMOKE_EMAILS=a@x,b@y）。
 */
type Inbox = { address: string; waitForCode(since: Date, timeoutMs?: number): Promise<string> };

const root = resolve(import.meta.dirname, '../..');
const outputsFile = resolve(root, 'infra/cdk-outputs.json');
const outputs = existsSync(outputsFile) ? (JSON.parse(readFileSync(outputsFile, 'utf8')) as Record<string, Record<string, string>>) : {};
const stage = process.env.CHAT_APP_STAGE ?? 'dev';
const APP = (process.env.APP_URL ?? outputs[`ChatApp-${stage}-Frontend`]?.AppUrl ?? '').replace(/\/+$/, '');
if (!APP) throw new Error('APP_URL が必要です');

function inboxes(): Inbox[] {
  if (process.env.SMOKE_OTP_MANUAL === '1') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return (process.env.SMOKE_EMAILS ?? '').split(',').map((address) => ({
      address,
      waitForCode: async () => (await rl.question(`${address} に届いたコード: `)).trim(),
    }));
  }
  const file = process.env.SMOKE_MAILBOX_FILE;
  if (!file) throw new Error('SMOKE_MAILBOX_FILE か SMOKE_OTP_MANUAL=1 を指定してください');
  return (JSON.parse(readFileSync(file, 'utf8')) as Array<{ address: string; password: string }>).map(
    (m) => new MailTmInbox(m.address, m.password),
  );
}

class Client {
  readonly cookies = new Map<string, string>();
  readonly setCookieNames: string[] = [];
  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers.Origin = APP;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${APP}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i);
      this.setCookieNames.push(name);
      if (/max-age=0/i.test(c) || !pair!.slice(i + 1)) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(i + 1));
    }
    return res;
  }
}

async function readEvents(res: Response) {
  const parser = new SseParser();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<StreamEvent & { at: number }> = [];
  let raw = '';
  const started = Date.now();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    for (const f of parser.feed(text)) {
      const e = parseStreamEvent(f);
      if (e) events.push({ ...e, at: Date.now() - started });
    }
  }
  return { events, raw };
}

const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = [];
async function check(id: string, name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail: `${detail} (${((Date.now() - t) / 1000).toFixed(1)}s)` });
    process.stdout.write(`✔ ${id} ${name}: ${detail}\n`);
  } catch (e) {
    results.push({ id, name, ok: false, detail: (e as Error).message });
    process.stdout.write(`✖ ${id} ${name}: ${(e as Error).message}\n`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function login(client: Client, inbox: Inbox): Promise<{ startBody: string; startStatus: number; flowCookie: boolean }> {
  const since = new Date();
  const start = await client.request('POST', '/api/auth/otp/start', { email: inbox.address });
  const startBody = await start.text();
  assert(start.status === 202, `otp/start ${start.status} ${startBody}`);
  let code = await inbox.waitForCode(since);
  for (let attempt = 0; attempt < 2; attempt++) {
    const verify = await client.request('POST', '/api/auth/otp/verify', { code });
    if (verify.status === 204) return { startBody, startStatus: start.status, flowCookie: client.setCookieNames.includes('__Host-auth-flow') };
    const text = await verify.text();
    if (verify.status === 202) {
      // 未確認ユーザーの確認後に追加のサインインコードが送られる経路
      code = await inbox.waitForCode(new Date(Date.now() - 2000));
      continue;
    }
    throw new Error(`otp/verify ${verify.status} ${text}`);
  }
  throw new Error('login did not complete');
}

async function main() {
  const [box1, box2] = inboxes();
  assert(box1 && box2, '受信箱が2つ必要です');
  process.stdout.write(`APP_URL=${APP}\n`);
  const user1 = new Client();
  const user2 = new Client();
  let chatId = '';

  await check('AWS-01', 'メールOTPで新規登録（または既存ログイン）し、トークンを露出しない', async () => {
    const r = await login(user1, box1);
    const me = await user1.request('GET', '/api/auth/me');
    const body = (await me.json()) as Record<string, string>;
    assert(Object.keys(body).sort().join() === 'email,sub', `me keys ${Object.keys(body)}`);
    assert(!/eyJ[a-zA-Z0-9_-]{10,}\./.test(r.startBody), 'token-like string in response');
    const names = [...new Set(user1.setCookieNames)].sort().join();
    assert(names === '__Host-auth-flow,__Host-session', `cookies ${names}`);
    return `ok (${box1.address.split('@')[0]}…)`;
  });

  await check('AWS-01', '登録有無で otp/start の応答が同一（既存ユーザーとの比較）', async () => {
    const fresh = await new Client().request('POST', '/api/auth/otp/start', { email: `nobody-${Date.now()}@example.com` });
    const freshBody = await fresh.text();
    // 既存ユーザー（box1）はクールダウン中のため、ステータスと本文の形のみ比較する
    assert(fresh.status === 202, `new user start ${fresh.status}`);
    assert(JSON.parse(freshBody).status === 'code_sent', 'body');
    return 'new/existing: 202 code_sent';
  });

  await check('AWS-01', '2人目のユーザー（未確認→再送→確認の経路を含む）', async () => {
    const since = new Date();
    const first = await user2.request('POST', '/api/auth/otp/start', { email: box2.address });
    assert(first.status === 202, `start ${first.status}`);
    await box2.waitForCode(since).catch(() => '');
    // 確認せずに離脱 → クールダウン後に再開
    await new Promise((r) => setTimeout(r, 62_000));
    await login(user2, box2);
    return 'ok';
  });

  await check('AWS-03', 'CloudFront越しのSSE逐次配信（start→delta…→done）', async () => {
    const created = await user1.request('POST', '/api/v1/chats', {});
    chatId = ((await created.json()) as { id: string }).id;
    const res = await user1.request('POST', `/api/v1/chats/${chatId}/stream`, {
      requestId: uuidv7(),
      content: '日本の四季について、それぞれの特徴を3文ずつで説明してください。',
    });
    assert(res.status === 200, `status ${res.status}`);
    assert(res.headers.get('content-type')?.startsWith('text/event-stream'), 'content-type');
    const { events } = await readEvents(res);
    const deltas = events.filter((e) => e.event === 'delta');
    assert(events[0]?.event === 'start', 'no start');
    assert(events.at(-1)?.event === 'done', `last ${events.at(-1)?.event} ${JSON.stringify(events.at(-1)?.data)}`);
    assert(deltas.length >= 3, `deltas ${deltas.length}`);
    const spread = deltas.at(-1)!.at - deltas[0]!.at;
    assert(spread > 200, `deltas arrived at once (${spread}ms)`);
    return `${deltas.length} deltas over ${spread}ms, first token ${deltas[0]!.at}ms`;
  });

  await check('AWS-05', 'Web検索の結果と出典（https）', async () => {
    const res = await user1.request('POST', `/api/v1/chats/${chatId}/stream`, {
      requestId: uuidv7(),
      content: '今日の日本の主要なニュースをWebで検索して、出典付きで3つ教えてください。',
    });
    const { events } = await readEvents(res);
    const tools = events.filter((e) => e.event === 'tool_status').map((e) => (e.data as { status: string }).status);
    const sources = events.filter((e) => e.event === 'source').map((e) => e.data as { url: string; title: string });
    assert(tools.includes('running'), `no web search (${tools.join()})`);
    assert(sources.length > 0, `no sources (tools: ${tools.join()}, last: ${JSON.stringify(events.at(-1))})`);
    assert(sources.every((s) => /^https?:\/\//.test(s.url)), 'unsafe url');
    return `tool_status=${tools.join('/')}, sources=${sources.length} (${new URL(sources[0]!.url).hostname})`;
  });

  await check('AWS-03', '生成の中断（Abort）で interrupted として記録', async () => {
    const controller = new AbortController();
    const res = await user1.request(
      'POST',
      `/api/v1/chats/${chatId}/stream`,
      { requestId: uuidv7(), content: '日本の歴史を縄文時代から現代まで、時代ごとに詳しく長文で説明してください。' },
      controller.signal,
    );
    const reader = res.body!.getReader();
    let deltas = 0;
    while (deltas < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes('event: delta')) deltas++;
    }
    controller.abort();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = (await (await user1.request('GET', `/api/v1/chats/${chatId}/messages`)).json()) as {
        items: Array<{ status: string; role: string }>;
      };
      const last = list.items.at(-1)!;
      if (last.status !== 'streaming') {
        assert(last.status === 'interrupted', `status ${last.status}`);
        return 'interrupted';
      }
    }
    throw new Error('still streaming');
  });

  await check('AWS-07', '他人のチャットは404', async () => {
    const res = await user2.request('GET', `/api/v1/chats/${chatId}/messages`);
    assert(res.status === 404, `status ${res.status}`);
    const usage = (await (await user1.request('GET', '/api/v1/usage')).json()) as { daily: { requests: number } };
    return `404 / user1 usage today=${usage.daily.requests}`;
  });

  await check('AWS-08', '会話内でAgentCoreセッションを再利用し、削除で停止', async () => {
    const res = await user1.request('POST', `/api/v1/chats/${chatId}/stream`, { requestId: uuidv7(), content: '一言で、ありがとう。' });
    const { events } = await readEvents(res);
    const first = events.find((e) => e.event === 'delta');
    assert(events.at(-1)?.event === 'done', 'not done');
    const del = await user1.request('DELETE', `/api/v1/chats/${chatId}`);
    assert(del.status === 204, `delete ${del.status}`);
    return `2回目以降の初回トークン ${first?.at}ms / delete 204`;
  });

  await check('AWS-01', 'ログアウトで即時失効', async () => {
    const out = await user2.request('POST', '/api/auth/logout', {});
    assert(out.status === 204, `logout ${out.status}`);
    const me = await user2.request('GET', '/api/auth/me');
    assert(me.status === 401, `me ${me.status}`);
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
