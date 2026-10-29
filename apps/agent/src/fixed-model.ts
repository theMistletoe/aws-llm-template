import {
  FIXED_DIRECTIVES,
  FIXED_MARKDOWN_REPLY,
  fixedReply,
  fixedSearchAnswer,
  wantsSearch,
} from '@ai-chat/test-fixtures';
import {
  Model,
  ModelError,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StopReason,
  type StreamOptions,
} from '@strands-agents/sdk';

/**
 * ローカル・テスト用の決定的なモデルプロバイダ（§6.6 FixedModelProvider）。ネットワークに出ない。
 * - 検索系の質問（「最新」「検索」等）では web_search ツールを呼び、結果を受けて定型回答を返す
 * - それ以外は定型文を返す
 * - テスト用ディレクティブ（[[slow]] 等）は @ai-chat/test-fixtures を参照
 */
export interface FixedModelConfig extends BaseModelConfig {
  chunkSize?: number;
  chunkDelayMs?: number;
}

type Turn = { text?: string; toolUse?: { name: string; input: { query: string } }; stopReason?: StopReason };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = m.content.map((b) => (b.type === 'textBlock' ? b.text : '')).join('');
    if (text) return text;
  }
  return '';
}

function parseTitles(toolResultText: string): Array<{ title: string }> {
  try {
    const parsed = JSON.parse(toolResultText.slice(toolResultText.indexOf('{'))) as { results?: Array<{ title: string }> };
    return parsed.results ?? [];
  } catch {
    return [];
  }
}

function respond(messages: Message[], options?: StreamOptions): Turn {
  const last = messages.at(-1);
  const toolResult = last?.content.find((b) => b.type === 'toolResultBlock');
  if (toolResult && toolResult.type === 'toolResultBlock') {
    if (toolResult.status === 'error') return { text: fixedSearchAnswer([]) };
    const text = toolResult.content.map((c) => (c.type === 'textBlock' ? c.text : '')).join('');
    return { text: fixedSearchAnswer(parseTitles(text)) };
  }
  const userText = lastUserText(messages);
  if (userText.includes(FIXED_DIRECTIVES.error)) throw new ModelError('fixed model error (test directive)');
  const canSearch = (options?.toolSpecs ?? []).some((t) => t.name === 'web_search');
  if (canSearch && wantsSearch(userText)) {
    return { text: 'Webを検索します。', toolUse: { name: 'web_search', input: { query: userText } } };
  }
  if (userText.includes(FIXED_DIRECTIVES.markdown)) return { text: FIXED_MARKDOWN_REPLY };
  if (userText.includes(FIXED_DIRECTIVES.maxTokens)) return { text: fixedReply(userText), stopReason: 'maxTokens' };
  return { text: fixedReply(userText) };
}

export class FixedModelProvider extends Model<FixedModelConfig> {
  private config: FixedModelConfig;
  callCount = 0;
  readonly seenToolNames: string[][] = [];

  constructor(config: FixedModelConfig = {}) {
    super();
    this.config = { modelId: 'local-fixed-model', chunkSize: 6, chunkDelayMs: 15, ...config };
  }

  updateConfig(modelConfig: FixedModelConfig): void {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig(): FixedModelConfig {
    return { ...this.config };
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const callIndex = this.callCount++;
    this.seenToolNames.push((options?.toolSpecs ?? []).map((t) => t.name));
    const signal = options?.cancelSignal;
    const userText = lastUserText(messages);
    const turn = respond(messages, options);
    const slow = userText.includes(FIXED_DIRECTIVES.slow);
    const delay = slow ? 300 : (this.config.chunkDelayMs ?? 0);
    const pause = FIXED_DIRECTIVES.pausePattern.exec(userText);
    if (pause && callIndex === 0) await sleep(Number(pause[1]), signal);

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    let output = '';
    if (turn.text) {
      yield { type: 'modelContentBlockStartEvent' };
      const size = this.config.chunkSize ?? 6;
      for (let i = 0; i < turn.text.length; i += size) {
        await sleep(delay, signal);
        const piece = turn.text.slice(i, i + size);
        output += piece;
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: piece } };
      }
      yield { type: 'modelContentBlockStopEvent' };
    }
    if (turn.toolUse) {
      const input = JSON.stringify(turn.toolUse.input);
      output += input;
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: turn.toolUse.name, toolUseId: `tooluse_fixed_${callIndex}` },
      };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: turn.stopReason ?? (turn.toolUse ? 'toolUse' : 'endTurn') };
    const inputTokens = estimateTokens(JSON.stringify(messages.map((m) => m.toJSON())));
    const outputTokens = estimateTokens(output);
    yield {
      type: 'modelMetadataEvent',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      metrics: { latencyMs: 1 },
    };
  }
}
