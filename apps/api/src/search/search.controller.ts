import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import type { SearchResponse } from '@knowledgecool/shared';

import { SearchService } from './search.service.js';

/**
 * 检索接口(DESIGN.md §6.2)。
 *
 * ⚠️ **v2.0 起不做权限过滤** —— 读对所有登录用户开放(§5.3 规则一)。
 * 所以这里既不需要当前用户,也不再需要 `spaceId` 限定范围。
 *
 * 这**不是**漏了过滤:代价与理由写在 `SearchService` 顶部。
 * 简言之 —— 检索里没有任何"隐藏项",因为树上本来就没有。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  run(@Query('q') q?: string): Promise<SearchResponse> {
    return this.search.search(q ?? '');
  }
}
