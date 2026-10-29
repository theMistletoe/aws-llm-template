import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import type { AgentRunner } from '@ai-chat/agent-contracts';
import type { OtpAuthProvider } from '@ai-chat/auth';
import { createDynamoDocumentClient, type AwsTarget } from '@ai-chat/aws-clients';
import type { ApiConfig } from '@ai-chat/config';
import { monotonicFactory } from 'ulid';
import { AgentCoreRunner } from './agent/agentcore-runner';
import { HttpAgentRunner } from './agent/http-agent-runner';
import type { AppDeps } from './deps';
import { createLogger } from './lib/logger';
import { ChatRepository } from './repositories/chat-repository';
import { SessionRepository } from './repositories/session-repository';

/** 実行モード共通の依存組み立て。認証プロバイダとOrigin解決は呼び出し側（エントリ）が注入する */
export function buildDeps(
  config: ApiConfig,
  overrides: { auth: OtpAuthProvider; resolveAppOrigin: () => Promise<string>; agent?: AgentRunner },
): AppDeps {
  const target: AwsTarget =
    config.mode === 'local'
      ? { mode: 'local', region: config.region, endpoint: config.awsEndpointUrl! }
      : { mode: 'aws', region: config.region };
  const db = createDynamoDocumentClient(target);
  const ulid = monotonicFactory();
  const agent =
    overrides.agent ??
    (config.agent.backend === 'agentcore'
      ? new AgentCoreRunner({
          client: new BedrockAgentCoreClient({ region: config.region }),
          runtimeArn: config.agent.runtimeArn,
          qualifier: config.agent.qualifier,
          readTimeoutMs: config.generation.agentReadTimeoutMs,
        })
      : new HttpAgentRunner(config.agent.url, config.generation.agentReadTimeoutMs));
  return {
    config,
    clock: { now: () => new Date() },
    newId: () => ulid(),
    chats: new ChatRepository(db, config.tables.data),
    sessions: new SessionRepository(db, config.tables.session),
    auth: overrides.auth,
    agent,
    logger: createLogger(config.logLevel, { service: 'api', mode: config.mode }),
    resolveAppOrigin: overrides.resolveAppOrigin,
  };
}
