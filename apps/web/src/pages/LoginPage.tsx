import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import { formatResumeTime } from '../components/format';
import { queryKeys, useMe } from '../hooks/queries';

/** ログイン後の戻り先。同一サイト内の相対パスのみ許可する（オープンリダイレクト対策） */
export function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/chat/new';
}

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiRequestError)) return 'エラーが発生しました。時間をおいて再度お試しください。';
  switch (e.code) {
    case 'RATE_LIMITED':
      return e.retryAfter
        ? `送信回数が多すぎます。${formatResumeTime(e.retryAfter)}以降に再度お試しください。`
        : 'しばらく待ってから再度お試しください。';
    case 'INVALID_CODE':
      return '確認コードが正しくありません。もう一度入力してください。';
    case 'AUTH_FLOW_EXPIRED':
      return 'コードの有効期限が切れました。もう一度コードを送信してください。';
    case 'VALIDATION_ERROR':
      return '入力内容を確認してください。';
    case 'NETWORK_ERROR':
      return 'サーバーに接続できませんでした。';
    default:
      return e.message;
  }
}

/**
 * メールアドレス入力 → コード入力の1画面2ステップ（新規・既存共通。§3 UI要件11）。
 * 新規か既存かを画面上で区別しない。
 */
export function LoginPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (me.data) return <Navigate to={next} replace />;

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.startOtp(email);
      setStep('code');
      setCode('');
      setCooldown(res.resendAfterSeconds);
      setInfo(`${email.trim()} に確認コードを送信しました。メールに記載のコードを入力してください。`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyOtp(code);
      if (res?.status === 'additional_code_sent') {
        setInfo(res.message);
        setCode('');
        setCooldown(60);
        return;
      }
      await queryClient.fetchQuery({ queryKey: queryKeys.me, queryFn: api.me });
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiRequestError && err.code === 'AUTH_FLOW_EXPIRED') {
        setStep('email');
        setInfo(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-100 p-4 dark:bg-gray-950">
      <main className="w-full max-w-md rounded-2xl bg-white p-6 shadow dark:bg-gray-900 dark:text-gray-100">
        <h1 className="mb-1 text-xl font-bold">ログイン / 新規登録</h1>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
          メールアドレスに届く確認コードでログインします。アカウントがない場合は自動で作成されます。
        </p>
        {info ? (
          <p role="status" className="mb-3 rounded bg-teal-50 p-2 text-sm text-teal-900">
            {info}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 rounded bg-red-50 p-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        {step === 'email' ? (
          <form onSubmit={sendCode} className="space-y-3">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium">
                メールアドレス
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-gray-300 p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:bg-gray-800"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="w-full rounded-lg bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-50"
            >
              コードを送信
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <div>
              <label htmlFor="code" className="mb-1 block text-sm font-medium">
                確認コード
              </label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={8}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg border border-gray-300 p-2 text-center text-lg tracking-widest focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:bg-gray-800"
              />
            </div>
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="w-full rounded-lg bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-50"
            >
              ログイン
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <button
                type="button"
                onClick={() => void sendCode()}
                disabled={busy || cooldown > 0}
                className="rounded px-2 py-1 text-teal-700 hover:underline disabled:text-gray-400 disabled:no-underline"
              >
                {cooldown > 0 ? `コードを再送（${cooldown}秒後）` : 'コードを再送'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setInfo(null);
                  setError(null);
                  setCode('');
                }}
                className="rounded px-2 py-1 text-gray-600 hover:underline dark:text-gray-300"
              >
                メールアドレスを入力し直す
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
