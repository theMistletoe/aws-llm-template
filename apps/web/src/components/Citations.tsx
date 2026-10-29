import { isSafeHttpUrl, type Citation } from '@ai-chat/contracts';

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Web検索の出典（タイトル・URL・公開日）。http/https以外のURLはリンクにしない（§3 UI要件8） */
export function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  return (
    <section aria-label="出典" className="mt-3 border-t border-gray-200 pt-2 text-sm dark:border-gray-700">
      <h3 className="mb-1 font-semibold text-gray-600 dark:text-gray-300">出典</h3>
      <ol className="list-decimal space-y-1 pl-5">
        {citations.map((c) => (
          <li key={c.url}>
            {isSafeHttpUrl(c.url) ? (
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-teal-700 underline dark:text-teal-300">
                {c.title}
              </a>
            ) : (
              <span>{c.title}</span>
            )}
            <span className="ml-2 text-gray-500">{hostOf(c.url)}</span>
            {c.publishedDate ? <span className="ml-2 text-gray-500">公開日: {c.publishedDate}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
