import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './styles.css';

/**
 * 服务端状态交给 TanStack Query,本地 UI 状态用 Zustand(DESIGN.md §7.3)。
 *
 * Zustand 目前仍未接入:M2 的界面状态(表单草稿、折叠)都由组件自己 useState
 * 就够了,引入一个全局 store 是空架子。等 M3 的页面树有了跨组件的选中态再上。
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
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
