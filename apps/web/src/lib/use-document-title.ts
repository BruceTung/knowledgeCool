/**
 * 按页面设置浏览器标签标题(v2.12)。
 *
 * 在此之前**所有标签页都叫「知源 KnowledgeCool」** —— 同时开着好几篇文档时,
 * 标签栏上完全分不出哪个是哪个,而这恰恰是知识库最常见的用法。
 *
 * 用一个极小的 hook 而不是路由配置表:标题常常依赖**数据**
 * (文档标题要等详情拉回来才知道),写在组件里最直接。
 */
import { useEffect } from 'react';

const SUFFIX = '知源 KnowledgeCool';

export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined || title.trim() === '') return;
    document.title = `${title.trim()} · ${SUFFIX}`;
    // 卸载时**不还原**成默认标题:紧接着挂载的下一页会立刻设自己的标题,
    // 中间那一帧的闪动比"暂时保留上一个标题"更让人困惑。
    //
    // ⚠️ v5.43 更正:真正需要还原的场景(回到首页)由 **`AppLayout` 的路由标题表**
    // 负责(见 AppLayout 里 `useDocumentTitle(routeTitle)`),**不是 HomePage** ——
    // HomePage 里根本没有这个调用。原注释写着"见 HomePage",照着它去找会找不到。
    //
    // 拆成两处的原因是职责不同:页面级标题(文档名)依赖**数据**,要等详情拉回来
    // 才知道,所以写在页面组件里;而路由级的默认标题是静态映射,集中在 AppLayout
    // 一处更好维护 —— 少一处就少一处可能漏。
  }, [title]);
}
