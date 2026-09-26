import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

/**
 * 服务端状态交给 TanStack Query(DESIGN.md §7.3)。
 * 本地 UI 状态用 Zustand,等 M2 有真实交互状态再接入 —— 现在引入是空架子。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 内网环境稳定,重试 1 次足够;不做无限重试,免得后端挂了还在猛打。
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const container = document.getElementById('root');
if (container === null) {
  throw new Error('找不到 #root 挂载点,index.html 可能被改坏了');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
