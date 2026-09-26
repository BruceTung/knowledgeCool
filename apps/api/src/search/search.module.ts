import { Module } from '@nestjs/common';

import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/**
 * 检索模块。
 *
 * ⚠️ **v2.0 起不再依赖 `PermissionModule`** —— 检索不做权限过滤了,
 * 也就不需要算"可见范围"。旧注释里那条"可见范围必须与节点树完全一致,
 * 否则会出现树上看不到但搜得到"的要求随之作废:
 * 树上与检索里都是全集,不存在两边不一致的可能。
 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
