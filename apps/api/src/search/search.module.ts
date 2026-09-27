import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/**
 * 检索模块。
 *
 * ⚠️ **v2.0~v2.11 不依赖 `PermissionModule`** —— 那时检索不做权限过滤,
 * 因为读对全员开放。**v2.12 起又要了**:有了受限节点之后,检索必须问一句
 * "这一条他读不读得到",否则保密只挡住了树与详情,却从检索漏出去。
 *
 * 顺带一提,v2.0 那条注释里预言的正是现在这件事:
 * 「可见范围必须与节点树完全一致,否则会出现树上看不到但搜得到」。
 * 当时两边都是全集所以不成问题;现在两边都靠同一份判定,所以也不会不一致。
 */
@Module({
  imports: [PermissionModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
