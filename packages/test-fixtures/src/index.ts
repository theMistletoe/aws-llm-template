/**
 * テスト・ローカル開発用の決定的なフィクスチャ。
 * FixedModelProvider（apps/agent）の応答文面とテストの期待値をここで共有する。
 */

export const DEV_AUTH_CODE = '000000';

/** 固定モデルの応答の冒頭 */
export const FIXED_REPLY_PREFIX = 'ローカル固定モデルの応答です。';

/** これらの語を含む質問では固定モデルがweb_searchツールを呼ぶ */
export const SEARCH_TRIGGER_WORDS = ['検索', '最新', 'ニュース', 'search', 'latest'] as const;

/**
 * テスト用ディレクティブ（固定モデルのみが解釈する。本番モデルには無関係）
 * - [[slow]]       : チャンク間隔を長くする（中断テスト用）
 * - [[pause:ms]]   : 応答開始前に指定ミリ秒待つ（ハートビート確認用）
 * - [[error]]      : モデルエラーを発生させる
 * - [[max_tokens]] : 出力上限で打ち切られたとして終了する
 * - [[markdown]]   : Markdown/XSSを含む応答を返す
 * - [[search_fail]]: Web検索fixtureを失敗させる
 */
export const FIXED_DIRECTIVES = {
  slow: '[[slow]]',
  error: '[[error]]',
  maxTokens: '[[max_tokens]]',
  markdown: '[[markdown]]',
  searchFail: '[[search_fail]]',
  pausePattern: /\[\[pause:(\d{1,6})\]\]/,
} as const;

export function wantsSearch(message: string): boolean {
  const lower = message.toLowerCase();
  return SEARCH_TRIGGER_WORDS.some((w) => lower.includes(w));
}

/** 固定モデルの通常応答 */
export function fixedReply(message: string): string {
  const quoted = [...message.replace(/\[\[[^\]]*\]\]/g, '').trim()].slice(0, 40).join('');
  return `${FIXED_REPLY_PREFIX}「${quoted}」について、ローカル環境ではAIモデルを呼ばずにこの定型文を返します。`;
}

/** 検索結果を受けた後の固定応答 */
export function fixedSearchAnswer(sources: ReadonlyArray<{ title: string }>): string {
  if (sources.length === 0) {
    return `${FIXED_REPLY_PREFIX}Web検索を実行しましたが、結果を取得できませんでした。最新情報は未確認です。`;
  }
  const list = sources.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  return `${FIXED_REPLY_PREFIX}Web検索の結果、次の情報が見つかりました。\n\n${list}\n\n詳細は出典をご確認ください。`;
}

/** XSS・Markdownのサニタイズ確認用の応答 */
export const FIXED_MARKDOWN_REPLY = [
  '## 見出し',
  '',
  '**太字** と `inline code`、[安全なリンク](https://example.com/docs) と [危険なリンク](javascript:alert(1))。',
  '',
  '<script>alert("xss")</script><img src=x onerror=alert(1)>',
  '',
  '```html',
  '<b>escaped</b>',
  '```',
].join('\n');

let counter = 0;
/** テストごとに独立したユーザーのメールアドレス */
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${counter}-${rand}@example.test`;
}

/** 進められるテスト用の時計 */
export function createFakeClock(start: Date | string = '2026-10-29T00:00:00.000Z') {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
    set(value: Date | string) {
      current = new Date(value).getTime();
    },
  };
}
export type FakeClock = ReturnType<typeof createFakeClock>;
