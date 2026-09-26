import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { SpaceModule } from '../space/space.module.js';
import { ContentService } from './content.service.js';
import { PageController } from './page.controller.js';
import { PageService } from './page.service.js';

/**
 * 页面树与正文模块。
 *
 * 依赖关系说明:
 *  - **SpaceModule**:回收站列表这类"空间级"读取仍走空间角色,
 *    空间级判定只应该有一处实现。
 *  - **PermissionModule**:页面级操作(编辑/移动/删除/正文)一律走它。
 *    M5 起页面模块里**不再**直接调 `spaces.requireCapability` 做写操作鉴权 ——
 *    那会绕过页面级规则,而且绕过之后不会有任何报错。
 *
 * 审计**不需要** import 模块:写入是纯函数(audit/record.ts),
 * 只要手里有 PrismaService 就能写。这样避免了模块环。
 */
@Module({
  imports: [SpaceModule, PermissionModule],
  controllers: [PageController],
  providers: [PageService, ContentService],
  exports: [PageService, ContentService],
})
export class PageModule {}
