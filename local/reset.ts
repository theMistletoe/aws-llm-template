import { pathToFileURL } from 'node:url';
import { parseProfiles, reset } from './lib';
import { preflight } from './preflight';

/** テスト用テーブルを削除して作り直す（冪等）。既定は test と e2e。開発データ（local）は `--profile local` 指定時のみ */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preflight({ ensureUp: true })
    .then(() => reset(parseProfiles(process.argv, ['test', 'e2e'])))
    .catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
}
