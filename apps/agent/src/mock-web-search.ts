import { FIXED_DIRECTIVES } from '@ai-chat/test-fixtures';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WebSearchProvider, WebSource } from './web-search';

const fixtureSchema = z.object({
  /** クエリにいずれかが含まれると採用される（大文字小文字は無視）。空なら既定fixture */
  keywords: z.array(z.string()),
  results: z.array(
    z.object({ title: z.string(), url: z.string(), snippet: z.string(), publishedDate: z.string().optional() }),
  ),
});
type Fixture = z.infer<typeof fixtureSchema> & { name: string };

/**
 * ローカル用の検索プロバイダ（§6.6）。`local/fixtures/search/*.json` の固定データを返し、ネットワークに出ない。
 * 「検索できるように見えるが実際には固定データ」。
 */
export class FixtureWebSearchProvider implements WebSearchProvider {
  private readonly fixtures: Fixture[];

  constructor(dir: string) {
    this.fixtures = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ name: f, ...fixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))) }));
    if (!this.fixtures.some((f) => f.keywords.length === 0)) {
      throw new Error(`No default fixture (keywords: []) in ${dir}`);
    }
  }

  async search(query: string, signal?: AbortSignal): Promise<readonly WebSource[]> {
    if (signal?.aborted) throw signal.reason;
    if (query.includes(FIXED_DIRECTIVES.searchFail)) throw new Error('fixture search failure');
    const q = query.toLowerCase();
    const match =
      this.fixtures.find((f) => f.keywords.some((k) => q.includes(k.toLowerCase()))) ??
      this.fixtures.find((f) => f.keywords.length === 0)!;
    return match.results;
  }
}
