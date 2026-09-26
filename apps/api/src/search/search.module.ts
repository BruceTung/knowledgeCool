import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/**
 * 检索模块。
 *
 * 只依赖 PermissionModule —— 可见范围的计算必须和页面树的可见范围**完全一致**,
 * 否则会出现"树上看不到、但搜得到"。两处共用同一个 `visibility()` 就杜绝了这种漂移。
 */
@Module({
  imports: [PermissionModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
