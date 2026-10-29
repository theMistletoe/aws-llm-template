import { isSafeHttpUrl } from '@ai-chat/contracts';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** リンク先は http/https のみ許可（javascript: 等は除去） */
export const safeUrlTransform = (url: string) => (isSafeHttpUrl(url) ? url : '');

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal-700 underline dark:text-teal-300">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span>{alt ? `[画像: ${alt}]` : '[画像]'}</span>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-gray-900 p-3 text-sm text-gray-100">{children}</pre>
  ),
  code: ({ children, className }) => <code className={className ?? 'rounded bg-gray-200 px-1 dark:bg-gray-700'}>{children}</code>,
};

/**
 * AI出力のMarkdown表示（§3 UI要件4）。生HTMLは描画しない（skipHtml）、URLはhttp/httpsのみ、
 * コードブロックはReactのテキストとしてエスケープされる。
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown space-y-2 leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrlTransform} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
