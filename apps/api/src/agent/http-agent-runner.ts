import { runtimeSessionIdFor, type AgentEvent, type AgentInvokeRequest, type AgentRunner } from '@ai-chat/agent-contracts';
import { agentEventsFromSse } from './agent-events';

/**
 * ローカル用: `apps/agent` のローカルプロセス（/invocations）をHTTPで呼ぶ。
 * MiniStackのAgentCoreはEcho応答のため使わない（§11.2）。
 */
export class HttpAgentRunner implements AgentRunner {
  constructor(
    private readonly baseUrl: string,
    private readonly readTimeoutMs: number,
  ) {}

  async *run(request: AgentInvokeRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    let res: Response;
    try {
      res = await fetch(new URL('/invocations', this.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': runtimeSessionIdFor(request.chatId, request.userSub),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.readTimeoutMs)]),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      yield { type: 'error', code: (e as Error).name === 'TimeoutError' ? 'MODEL_TIMEOUT' : 'AGENT_ERROR', retryable: true };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: 'error', code: 'AGENT_ERROR', retryable: res.status >= 500 };
      return;
    }
    yield* agentEventsFromSse(res.body, signal);
  }
}
