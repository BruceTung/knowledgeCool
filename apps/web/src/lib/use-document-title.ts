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
    // 但真正需要还原的场景(回到首页)由首页自己设 —— 见 HomePage。
  }, [title]);
}
