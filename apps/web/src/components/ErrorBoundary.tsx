/**
 * 渲染兜底(v2.12 新增)。
 *
 * 在此之前全站**没有 ErrorBoundary** —— 任何一处渲染期异常(编辑器扩展、
 * 组织树、表格)都会让 React 卸载整棵树,页面变成**白屏**,而用户看到的
 * 只有一句"什么都没了"。他没有刷新按钮以外的任何出路,也不会知道
 * 是"某一处坏了"还是"整个系统挂了"。
 *
 * 用类组件:错误边界是 React 里**唯一**必须用类实现的能力
 * (`getDerivedStateFromError` / `componentDidCatch` 没有函数式等价物)。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui';

interface Props {
  children: ReactNode;
  /** 出错时的说明。默认是通用文案;嵌在局部(例如只包住编辑器)时可以写得更具体。 */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 阶段一没有前端错误上报,至少把上下文留在控制台 —— 用户截图给我们时能对上。
    console.error('[渲染错误]', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <main className="flex min-h-full items-center justify-center bg-slate-50 p-8">
        <section className="w-full max-w-lg rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-base font-medium text-slate-900">
            {this.props.label ?? '这个页面出错了'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            页面在渲染时遇到异常,已经停下 —— <b>你刚才的编辑可能没有保存</b>。
            刷新后重试;如果反复出现,请把这个提示连同控制台里的
            <code className="mx-1 rounded bg-slate-100 px-1 text-xs">[渲染错误]</code>
            一并反馈。
          </p>
          <p className="mt-2 rounded bg-slate-50 px-2 py-1 font-mono text-xs break-words text-slate-500">
            {error.message}
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              onClick={() => {
                window.location.reload();
              }}
            >
              刷新页面
            </Button>
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              重试渲染
            </Button>
          </div>
        </section>
      </main>
    );
  }
}
