import type { AgentRunner } from '@ai-chat/agent-contracts';
import type { OtpAuthProvider } from '@ai-chat/auth';
import type { ApiConfig } from '@ai-chat/config';
import type { Logger } from './lib/logger';
import type { ChatRepository } from './repositories/chat-repository';
import type { SessionRepository } from './repositories/session-repository';

export type Clock = { now(): Date };

/** リポジトリの公開インターフェース（ユニットテストではインメモリ実装に差し替える） */
export type ChatStore = { [K in keyof ChatRepository]: ChatRepository[K] };
export type SessionStore = { [K in keyof SessionRepository]: SessionRepository[K] };

/** BFFの依存。AIモデル（AgentRunner）・認証・時刻・ID・永続化はすべて差し替え可能（§10） */
export type AppDeps = {
  config: ApiConfig;
  clock: Clock;
  /** 単調増加のULID */
  newId: () => string;
  chats: ChatStore;
  sessions: SessionStore;
  auth: OtpAuthProvider;
  agent: AgentRunner;
  logger: Logger;
  /** Originチェックに使うアプリURL（APP_ORIGIN、AWSではSSMパラメータからも解決） */
  resolveAppOrigin: () => Promise<string>;
};

export type SessionUser = { sub: string; email: string };

export type AppEnv = {
  Variables: {
    requestId: string;
    user: SessionUser;
    sessionHash: string;
    logger: Logger;
  };
};
