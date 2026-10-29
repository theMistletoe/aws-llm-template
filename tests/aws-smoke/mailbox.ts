/**
 * AWS dev 受入試験用の受信箱（任意）。
 * SES サンドボックスでは検証済みアドレスにしか送れないため、試験用アドレスを SES で検証して使う。
 * ここでは使い捨てメールサービス mail.tm の公開APIで受信する（本番の機能ではない。試験の自動化専用）。
 * 手動で試験する場合は SMOKE_OTP_MANUAL=1 を指定すると、コードの入力を標準入力で求める。
 */
const API = 'https://api.mail.tm';

type Message = { id: string; subject: string; createdAt: string; from: { address: string } };

export class MailTmInbox {
  private token: string | undefined;
  constructor(
    readonly address: string,
    private readonly password: string,
  ) {}

  static async create(prefix = 'chatkit'): Promise<MailTmInbox> {
    const domains = (await (await fetch(`${API}/domains`)).json()) as { 'hydra:member': Array<{ domain: string; isActive: boolean }> };
    const domain = domains['hydra:member'].find((d) => d.isActive)?.domain;
    if (!domain) throw new Error('mail.tm: no active domain');
    const address = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${domain}`;
    const password = `Pw-${crypto.randomUUID()}`;
    const res = await fetch(`${API}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password }),
    });
    if (!res.ok) throw new Error(`mail.tm: account creation failed (${res.status})`);
    return new MailTmInbox(address, password);
  }

  private async auth(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch(`${API}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: this.address, password: this.password }),
    });
    if (!res.ok) throw new Error(`mail.tm: login failed (${res.status})`);
    this.token = ((await res.json()) as { token: string }).token;
    return this.token;
  }

  async list(): Promise<Message[]> {
    const res = await fetch(`${API}/messages`, { headers: { Authorization: `Bearer ${await this.auth()}` } });
    if (!res.ok) throw new Error(`mail.tm: list failed (${res.status})`);
    return ((await res.json()) as { 'hydra:member': Message[] })['hydra:member'];
  }

  async body(id: string): Promise<string> {
    const res = await fetch(`${API}/messages/${id}`, { headers: { Authorization: `Bearer ${await this.auth()}` } });
    const msg = (await res.json()) as { text?: string; html?: string[] };
    return `${msg.text ?? ''}\n${(msg.html ?? []).join('\n')}`;
  }

  /** since 以降に届いた、条件に合う最初のメール本文を返す */
  async waitFor(match: (subject: string) => boolean, since: Date, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const messages = await this.list();
      const hit = messages
        .filter((m) => new Date(m.createdAt).getTime() >= since.getTime() - 5000 && match(m.subject))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (hit) return this.body(hit.id);
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('mail.tm: timed out waiting for email');
  }

  /** 本文から6〜8桁の確認コードを取り出す */
  async waitForCode(since: Date, timeoutMs = 120_000): Promise<string> {
    const body = await this.waitFor((s) => /AI Chat|code|コード|Verify/i.test(s), since, timeoutMs);
    const code = /(?<!\d)(\d{6,8})(?!\d)/.exec(body)?.[1];
    if (!code) throw new Error('mail.tm: code not found in email');
    return code;
  }
}
