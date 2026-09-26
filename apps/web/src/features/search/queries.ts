/**
 * 检索的服务端状态(DESIGN.md §8.3)。
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@knowledgecool/shared';

import { apiFetch } from '../../lib/api';

/**
 * 检索。
 *
 * `keepPreviousData` 是刻意的:命令面板里每敲一个字都会重查,
 * 没有它的话列表会在每次请求期间清空再重填 —— 视觉上闪得厉害,
 * 而且上下键选择会在闪的过程中跳到错误的位置。
 */
export function useSearch(query: string, spaceId?: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['search', trimmed, spaceId ?? ''],
    queryFn: () =>
      apiFetch<SearchResponse>(
        `/search?q=${encodeURIComponent(trimmed)}${
          spaceId === undefined ? '' : `&spaceId=${spaceId}`
        }`,
      ),
    enabled: trimmed !== '',
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
