import { pathToFileURL } from 'node:url';
import { parseProfiles, seed } from './lib';
import { preflight } from './preflight';

/** MiniStack に DynamoDB テーブルを作成する（存在すれば何もしない）。`--profile local|test|e2e|all` */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preflight({ ensureUp: true })
    .then(() => seed(parseProfiles(process.argv, ['local', 'test', 'e2e'])))
    .catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
}
