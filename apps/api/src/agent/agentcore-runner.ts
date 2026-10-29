import {
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  type BedrockAgentCoreClient,
} from '@aws-sdk/client-bedrock-agentcore';
import { runtimeSessionIdFor, type AgentEvent, type AgentInvokeRequest, type AgentRunner } from '@ai-chat/agent-contracts';
import { agentEventsFromSse } from './agent-events';

export type AgentCoreRunnerOptions = {
  client: BedrockAgentCoreClient;
  runtimeArn: string;
  /** 'DEFAULT' の場合は省略して送る（DEFAULTエンドポイント） */
  qualifier: string;
  readTimeoutMs: number;
};

/**
 * AWS用: BFFからAgentCore RuntimeをIAM/SigV4で呼ぶ（§1.4, §6.3）。
 * 会話ごとに1セッション（runtimeSessionIdはchatIdとuserSubから決定的に生成。§6.2）。
 */
export class AgentCoreRunner implements AgentRunner {
  constructor(private readonly options: AgentCoreRunnerOptions) {}

  private qualifier() {
    return this.options.qualifier === 'DEFAULT' ? {} : { qualifier: this.options.qualifier };
  }

  async *run(request: AgentInvokeRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.options.readTimeoutMs)]);
    let stream: ReadableStream<Uint8Array> | undefined;
    try {
      const res = await this.options.client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: this.options.runtimeArn,
          ...this.qualifier(),
          runtimeSessionId: runtimeSessionIdFor(request.chatId, request.userSub),
          contentType: 'application/json',
          accept: 'text/event-stream',
          payload: new TextEncoder().encode(JSON.stringify(request)),
        }),
        { abortSignal: combined },
      );
      stream = res.response?.transformToWebStream() as ReadableStream<Uint8Array> | undefined;
    } catch (e) {
      if (signal.aborted) throw e;
      const name = (e as Error).name;
      yield {
        type: 'error',
        code: name === 'TimeoutError' ? 'MODEL_TIMEOUT' : name === 'ThrottlingException' ? 'MODEL_THROTTLED' : 'AGENT_ERROR',
        retryable: name !== 'ValidationException' && name !== 'AccessDeniedException',
      };
      return;
    }
    if (!stream) {
      yield { type: 'error', code: 'AGENT_ERROR', retryable: true };
      return;
    }
    yield* agentEventsFromSse(stream, combined);
  }

  async stopSession(params: { chatId: string; userSub: string }): Promise<void> {
    await this.options.client.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: this.options.runtimeArn,
        ...this.qualifier(),
        runtimeSessionId: runtimeSessionIdFor(params.chatId, params.userSub),
      }),
    );
  }
}
