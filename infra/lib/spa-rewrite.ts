/**
 * CloudFront Function（viewer-request）の SPA rewrite（§3）。このTypeScriptソースから関数コードを生成する。
 * - /api/* は絶対に書き換えない
 * - 拡張子付きファイル（静的アセット）は書き換えない
 * - それ以外のパス（/chat/:id 等）は /index.html を返す
 * CloudFront共通の 403/404→200 変換はAPIエラーも潰すため使わない。
 */
export function rewriteUri(uri: string): string {
  if (uri === '/api' || uri.indexOf('/api/') === 0) return uri;
  const lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') !== -1) return uri;
  return '/index.html';
}

type CloudFrontEvent = { request: { uri: string } };

/** CloudFront Functions（JS 2.0）にそのまま埋め込むハンドラ本体 */
export function functionSource(): string {
  return `${rewriteUri.toString()}
function handler(event) {
  var request = event.request;
  request.uri = rewriteUri(request.uri);
  return request;
}`;
}

/** テスト用: 生成したコードを評価してハンドラを得る */
export function evaluateFunction(): (event: CloudFrontEvent) => { uri: string } {
  return new Function(`${functionSource()}; return handler;`)() as (event: CloudFrontEvent) => { uri: string };
}
