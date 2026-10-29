import { decodeAgentEvent, type AgentEvent } from '@ai-chat/agent-contracts';
import { readSseFrames } from '@ai-chat/contracts';

/** Agent（AgentCore Runtime / ローカル）からのSSEを AgentEvent に変換する。未知・不正なイベントは捨てる */
export async function* agentEventsFromSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  for await (const frame of readSseFrames(body, signal)) {
    const event = decodeAgentEvent(frame.data);
    if (event) yield event;
  }
}
