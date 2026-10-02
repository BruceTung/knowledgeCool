import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { handleQueryError } from './lib/session-expiry';
import './styles.css';

/**
 * 服务端状态交给 TanStack Query,本地 UI 状态用 Zustand(DESIGN.md §7.3)。
 *
 * Zustand 目前仍未接入:界面状态(表单草稿、折叠)都由组件自己 useState
 * 就够了,引入一个全局 store 是空架子。等真的出现跨组件共享的选中态再上。
 *
 * ## ⚠️ 为什么在**这一层**挂会话过期的处理
 *
 * 在这之前,全应用唯一的 401 处理在 `RequireAuth`,而它只看 `me` 查询自己失败。
 * 会话在"人正在编辑"时过期的话,`me` 早就成功并被缓存,不会再失败 ——
 * 于是**没有任何人注意到**,编辑器的自动保存只把 401 当成一次普通的保存失败,
 * 横幅写着「继续输入会自动重试」,而它永远不会成功(见 `lib/session-expiry.ts`)。
 *
 * 挂在 QueryClient 的全局 `onError` 上,是为了让**每一处**请求都经过同一个判断 ——
 * 包括那些还没被写出来的调用点。逐处 try/catch 的写法迟早会漏。
 */
/*
  ⚠️ 查询与变更**两条路径都要接**。
  只挂 mutations 的 onError 会漏掉一类很常见的情况:会话过期后,
  某个**查询**(比如打开新页面时的 `GET /nodes/:id`)先撞上 401 ——
  那时横幅不会出现,用户只看到那一页"加载失败"。

  查询没有 `onError` 默认项(TanStack Query v5 把全局查询错误收敛到
  QueryCache 的订阅上),所以在这里显式建一个 `QueryCache`。
*/
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      handleQueryError(error);
    },
  }),
  defaultOptions: {
    queries: {
      // 内网环境稳定,重试 1 次足够;不做无限重试,免得后端挂了还在猛打。
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      onError: (error) => {
        handleQueryError(error);
      },
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
