import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/**
 * 审计模块(**读取侧**)。
 *
 * ⚠️ v2.0 起**不再依赖 `SpaceModule`**。旧版要靠它做 `requireCapability('audit.view')`,
 * 而新模型里"能看哪些日志"的判断就是"我拥有哪些节点的所有权" ——
 * 这个判断只需要 `PrismaService`,不需要任何其他服务的配合。
 *
 * 写入侧是纯函数(`record.ts`),不在本模块里。
 *
 * ⚠️ v5.45:**重新依赖 `PermissionModule`** —— 这条上面那段"只需要 PrismaService"
 * 已经不成立了。审计要按**读判定**过滤条目(见 `AuditService.readableNodeIds`),
 * 而"能不能读到这个节点"是 `PermissionService` 的职责。
 *
 * 上一版把可见性按「所有权」算,于是受限节点的标题与操作历史会漏给
 * 拥有它但读不到它的人(所有权可以严格宽于读,`PermissionService` 自己
 * 论证过这一点)。现在按读判定过滤,就必须把那个服务注入进来。
 *
 * ⚠️ 代价与教训:改构造函数依赖**必须同步改模块的 `imports`**,
 * 而这件事本地 typecheck 与 lint 都发现不了 —— Nest 的依赖注入是**运行时**解析的。
 * 第一次部署时它表现为容器反复重启 + `UnknownDependenciesException`,
 * 运维可见但本地无感。所以新增注入之后**必须在真机上看一次启动日志**。
 */
@Module({
  imports: [PermissionModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
