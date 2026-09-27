/**
 * 防抖(v2.12)。
 *
 * 命令面板与人员搜索此前**每敲一个键就发一次请求** —— 打"知识库"三个字
 * 就是三次检索。中文输入法下更糟:组合期间的每次 `change` 都会触发。
 *
 * 抽成 hook 而不是每个调用点自己写 `setTimeout`:那样必然有人忘了在
 * 依赖变化时清掉上一个定时器,表现是"搜索结果闪回上一个关键词的结果"。
 */
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(handle);
    };
  }, [value, delayMs]);

  return debounced;
}
