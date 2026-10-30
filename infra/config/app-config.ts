import type { DeploySettings } from './options';

/**
 * アプリ設定値（§9.2）。モデルID・生成の上限・アイドルタイムアウト等をここに集約し、
 * 環境変数として BFF / AgentCore Runtime へ渡す。変更はgit履歴で監査できる。
 */
export function appConfig(settings: DeploySettings) {
  return {
    appName: 'chat-app',
    modelId: settings.modelId,
    generation: {
      timeoutMs: 120_000,
      agentReadTimeoutMs: 130_000,
      bffMaxDurationSeconds: 150,
      lockTtlSeconds: 180,
      heartbeatIntervalMs: 15_000,
      maxOutputTokens: 2048,
      maxToolCalls: 3,
      contextTurns: 10,
    },
    session: { absoluteTtlSeconds: 8 * 3600, idleTtlSeconds: 30 * 60 },
    otp: { cooldownSeconds: 60, maxPerHour: 5, minResponseMs: 800 },
    agentCore: { idleRuntimeSessionTimeoutSeconds: 300, maxLifetimeSeconds: 28_800 },
    search: { maxResults: 5, maxQueryLength: 200, timeoutMs: 10_000, snippetMaxChars: 600, denyDomains: [] as string[] },
    logRetentionDays: 30,
  } as const;
}
export type AppConfig = ReturnType<typeof appConfig>;

/** 推論プロファイルIDから基盤モデルID（IAMで転送先リージョンの許可に使う）を取り出す */
export function baseModelId(modelId: string): string {
  return modelId.replace(/^(global|jp|apac|us|eu|au|ca|us-gov)\./, '');
}
