import { Module } from '@nestjs/common';

import { SpaceModule } from '../space/space.module.js';
import { PermissionController } from './permission.controller.js';
import { PermissionService } from './permission.service.js';

/**
 * 页面权限模块(DESIGN.md §5)。
 *
 * 这个模块是**权限判定的唯一入口**:页面、评论、检索三个模块都从这里拿
 * `PermissionService`,而不是各自写 `if (role === 'viewer')`。
 * §12 把权限判定列为"错了不会立刻报错"的头号高危逻辑,收敛成一处是唯一可行的做法。
 *
 * 审计走纯函数(audit/record.ts),所以这里不需要 import 审计模块。
 */
@Module({
  imports: [SpaceModule],
  controllers: [PermissionController],
  providers: [PermissionService],
  exports: [PermissionService],
})
export class PermissionModule {}
