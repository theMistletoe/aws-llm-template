import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { UNAUTHENTICATED_EVENT } from './api/client';
import { AppShell } from './components/AppShell';
import { FullPageMessage, RequireAuth } from './components/RequireAuth';
import { ChatStreamProvider } from './hooks/chat-stream';
import { queryKeys, useMe } from './hooks/queries';
import { ChatPage } from './pages/ChatPage';
import { ErrorPage } from './pages/ErrorPage';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';

function Landing() {
  const me = useMe();
  if (me.isPending) return <FullPageMessage>読み込み中…</FullPageMessage>;
  if (me.isError) return <Navigate to="/error?code=500" replace />;
  return <Navigate to={me.data ? '/chat/new' : '/login'} replace />;
}

function Authed({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}

export function App() {
  const queryClient = useQueryClient();
  useEffect(() => {
    // APIが401を返したらセッション切れとして扱い、ログイン画面へ誘導する
    const onUnauthenticated = () => queryClient.setQueryData(queryKeys.me, null);
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [queryClient]);

  return (
    <ChatStreamProvider>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/chat/new" element={<Authed><ChatPage /></Authed>} />
        <Route path="/chat/:chatId" element={<Authed><ChatPage /></Authed>} />
        <Route path="/settings" element={<Authed><SettingsPage /></Authed>} />
        <Route path="/error" element={<ErrorPage />} />
        <Route path="*" element={<ErrorPage code="404" />} />
      </Routes>
    </ChatStreamProvider>
  );
}
