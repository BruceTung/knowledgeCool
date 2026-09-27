import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import type { AuthUser, SearchResponse } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SearchService } from './search.service.js';

/**
 * 检索接口(DESIGN.md §6.2)。
 *
 * ⚠️ **v2.12 起要做保密过滤** —— 有了受限节点,检索必须按"他读不读得到"筛。
 * 所以这里又需要当前用户了(v2.0 期间读对全员开放,那时确实不需要)。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  run(@CurrentUser() user: AuthUser, @Query('q') q?: string): Promise<SearchResponse> {
    return this.search.search(user, q ?? '');
  }
}
