import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = resolve(ROOT, 'local/docker-compose.yml');
export const MINISTACK_ENDPOINT = process.env.MINISTACK_ENDPOINT ?? 'http://localhost:4566';
export const REGION = 'ap-northeast-1';

/** ローカルで使うダミー認証情報。12桁の数字にしない（MiniStackでは別アカウント扱いになるため） */
export const LOCAL_AWS_ENV = {
  AWS_REGION: REGION,
  AWS_ENDPOINT_URL: MINISTACK_ENDPOINT,
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_EC2_METADATA_DISABLED: 'true',
} as const;

export type Profile = 'local' | 'test' | 'e2e';
export const PROFILES: Profile[] = ['local', 'test', 'e2e'];

export const tableNames = (profile: Profile) => ({
  data: `chat-app-${profile}-data`,
  session: `chat-app-${profile}-session`,
});

export function dynamo(): DynamoDBClient {
  return new DynamoDBClient({
    region: REGION,
    endpoint: MINISTACK_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export function log(message: string) {
  process.stdout.write(`[local] ${message}\n`);
}

/** §7.1 のテーブル定義（CDKの DataStack と同じキー設計） */
async function createTables(client: DynamoDBClient, profile: Profile) {
  const names = tableNames(profile);
  const existing = new Set((await client.send(new ListTablesCommand({}))).TableNames ?? []);
  if (!existing.has(names.data)) {
    await client.send(
      new CreateTableCommand({
        TableName: names.data,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: names.data });
    await enableTtl(client, names.data);
  }
  if (!existing.has(names.session)) {
    await client.send(
      new CreateTableCommand({
        TableName: names.session,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }],
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: names.session });
    await enableTtl(client, names.session);
  }
}

async function enableTtl(client: DynamoDBClient, table: string) {
  try {
    await client.send(
      new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' } }),
    );
  } catch (e) {
    // 実DynamoDBは有効化済みの再設定を拒否する。MiniStackは受け付ける。どちらでも冪等にする
    if (!String((e as Error).message).includes('already enabled')) throw e;
  }
}

export async function seed(profiles: Profile[]) {
  const client = dynamo();
  for (const p of profiles) {
    await createTables(client, p);
    log(`tables ready: ${Object.values(tableNames(p)).join(', ')}`);
  }
}

export async function reset(profiles: Profile[]) {
  const client = dynamo();
  const existing = new Set((await client.send(new ListTablesCommand({}))).TableNames ?? []);
  for (const p of profiles) {
    for (const name of Object.values(tableNames(p))) {
      if (!existing.has(name)) continue;
      await client.send(new DeleteTableCommand({ TableName: name }));
      await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: name });
    }
    await createTables(client, p);
    log(`tables reset: ${Object.values(tableNames(p)).join(', ')}`);
  }
}

export function parseProfiles(argv: string[], fallback: Profile[]): Profile[] {
  const i = argv.indexOf('--profile');
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === 'all') return PROFILES;
  if (!value || !PROFILES.includes(value as Profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}, all`);
  return [value as Profile];
}

// ---------------------------------------------------------------------------
// Docker / MiniStack
// ---------------------------------------------------------------------------

export function dockerAvailable(): { ok: true } | { ok: false; reason: string } {
  const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (res.error) return { ok: false, reason: 'docker コマンドが見つかりません。Docker Desktop または互換エンジンをインストールしてください。' };
  if (res.status !== 0) return { ok: false, reason: 'Docker エンジンが起動していません。Docker Desktop 等を起動してから再実行してください。' };
  return { ok: true };
}

export async function ministackHealthy(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${MINISTACK_ENDPOINT}/_ministack/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  return waitFor(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }, timeoutMs, 300);
}

export function composeUp(): void {
  log('MiniStack を起動します（docker compose up -d --wait）');
  const res = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('MiniStack の起動に失敗しました（docker compose up）');
}

/** 子プロセスを起動し、出力に名前を付けて流す */
export function startProcess(
  name: string,
  command: string,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; logDir?: string } = {},
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (options.logDir) {
    // ログはファイルへ（E2E実行中の出力を見やすくする）
    mkdirSync(options.logDir, { recursive: true });
    const file = createWriteStream(resolve(options.logDir, `${name}.log`), { flags: 'w' });
    child.stdout?.pipe(file);
    child.stderr?.pipe(file);
    return child;
  }
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => `[${name}] ${l}\n`)
      .join('');
  child.stdout?.on('data', (c: Buffer) => process.stdout.write(prefix(c)));
  child.stderr?.on('data', (c: Buffer) => process.stderr.write(prefix(c)));
  return child;
}

export function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveStop();
    child.once('exit', () => resolveStop());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  });
}
