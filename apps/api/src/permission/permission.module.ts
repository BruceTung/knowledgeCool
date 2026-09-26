import { Module } from '@nestjs/common';

import { PermissionController } from './permission.controller.js';
import { PermissionService } from './permission.service.js';

/**
 * 权限模块 —— 权限判定的**唯一入口**。
 *
 * 不 import `AuditModule`:审计写入是纯函数(`audit/record.ts`),
 * 只要手里有 `PrismaService` 就能写。做成可注入服务会形成
 * `PermissionModule → AuditModule → ...` 的环,而审计**读取侧**确实需要校验权限,
 * 环一旦形成就很难拆。
 *
 * 同理也不 import 节点模块 —— `PermissionService` 只依赖 `Node` 表本身,
 * 不依赖 `NodeService` 的任何逻辑。
 */
@Module({
  controllers: [PermissionController],
  providers: [PermissionService],
  exports: [PermissionService],
})
export class PermissionModule {}
