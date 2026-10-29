import { serve } from '@hono/node-server';
import { loadAgentConfig } from '@ai-chat/config';
import { BedrockModel } from '@strands-agents/sdk';
import { createAgentApp } from './app';
import { AgentCoreGatewaySearchProvider } from './gateway-web-search';
import { createStrandsRunner } from './strands-runner';

/**
 * AgentCore Runtime 用エントリ（APP_MODE=aws）。Bedrockモデル + AgentCore Gateway Web Search。
 * 固定モデル・検索fixtureはこのバンドルに含めない（§1.5 fail-closed）。
 */
const config = loadAgentConfig(process.env);
if (config.mode !== 'aws') throw new Error('main.ts must run with APP_MODE=aws');

const search =
  config.search.enabled && config.search.gatewayUrl
    ? new AgentCoreGatewaySearchProvider({
        gatewayUrl: config.search.gatewayUrl,
        region: config.region,
        maxResults: config.search.maxResults,
      })
    : undefined;

const runner = createStrandsRunner({
  // AWS SDKクライアントはリクエストごとに生成する（microVMのスナップショット復元に備える）
  createModel: (maxTokens) =>
    new BedrockModel({
      modelId: config.model.modelId,
      region: config.region,
      maxTokens,
      temperature: config.model.temperature,
    }),
  ...(search ? { search } : {}),
  limits: config.search,
  inputBudgetChars: config.inputBudgetChars,
});

serve({ fetch: createAgentApp({ runner }).fetch, hostname: '0.0.0.0', port: config.port });
process.on('SIGTERM', () => process.exit(0));
