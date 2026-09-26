import { useQuery } from '@tanstack/react-query';

import type { HealthResponse } from '@knowledgecool/shared';

import { apiFetch } from './lib/api';

/**
 * M1 的占位首页。
 *
 * 刻意做成「真的去打后端」而不是一张静态图:
 * 它一次性验证了整条链路 —— Vite 代理 → NestJS 全局前缀 → 健康检查接口 → 共享类型。
 * 阶段一的主工作面(页面树 + 编辑器 + 右栏)从 M2 起逐步替换掉这里。
 */
export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/health'),
    retry: false,
  });

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 p-8">
      <section className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">知源 KnowledgeCool</h1>
        <p className="mt-1 text-sm text-slate-500">内网自托管 · 企业内部知识库</p>

        <div className="mt-6 rounded-lg bg-slate-50 p-4 text-sm">
          <div className="font-medium text-slate-700">后端连通性</div>

          {health.isPending ? (
            <p className="mt-1 text-slate-500">检查中…</p>
          ) : health.isError ? (
            <p className="mt-1 text-red-600">未连通:{health.error.message}</p>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-slate-600">
              <dt>状态</dt>
              <dd className="font-mono text-emerald-600">{health.data.status}</dd>
              <dt>版本</dt>
              <dd className="font-mono">{health.data.version}</dd>
              <dt>已运行</dt>
              <dd className="font-mono">{health.data.uptime} 秒</dd>
            </dl>
          )}
        </div>

        <p className="mt-4 text-xs text-slate-400">
          M1 基础设施骨架。登录、空间、页面树与编辑器自 M2 起接入。
        </p>
      </section>
    </main>
  );
}
