import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PermissionModule } from '../permission/permission.module.js';
import { OrgImportService } from './import.service.js';
import { OrgController } from './org.controller.js';
import { OrgService } from './org.service.js';

/**
 * 组织架构模块(v2.0 新增)。
 *
 * 它占了旧 `SpaceModule` 的位置,但职责不同 —— 旧的是"空间的增删改 + 成员邀请 +
 * 角色管理",新的只做**组织事实**:建节点、预置人员、维护归属、任命所有者。
 *
 * `AuthModule` 是为了拿 `PasswordService`(建人时要哈希初始密码)。
 * 注意 `AuthModule` 导出它而不是让本模块自己 new 一个 —— 那样两个模块
 * 会各自持有一份 bcrypt 配置。
 *
 * 不 import `AuditModule`:审计写入是纯函数(`audit/record.ts`)。
 */
@Module({
  imports: [AuthModule, PermissionModule],
  controllers: [OrgController],
  providers: [OrgService, OrgImportService],
  exports: [OrgService],
})
export class OrgModule {}
