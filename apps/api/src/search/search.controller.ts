import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import type { AuthUser, SearchResponse } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SearchService } from './search.service.js';

/**
 * 检索接口(DESIGN.md §6.2)。
 *
 * 只有一条路由,但它是整个产品里**最容易出安全事故**的一条 ——
 * 结果是按权限过滤后返回的,过滤逻辑在 SQL 里(§8.3),
 * 见 SearchService 顶部的说明。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  run(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('spaceId') spaceId?: string,
  ): Promise<SearchResponse> {
    return this.search.search(user, q ?? '', spaceId === undefined || spaceId === '' ? {} : { spaceId });
  }
}
