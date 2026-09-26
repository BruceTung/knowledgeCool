import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { ContentService } from './content.service.js';
import { NodeController } from './node.controller.js';
import { NodeService } from './node.service.js';
import { RetentionService } from './retention.service.js';

/**
 * 节点模块 —— 空间与页面合并后只剩这一个模块(v2.0)。
 *
 * `ContentService` 与 `NodeService` 放在同一个模块里,因为正文是节点的一部分,
 * 生命周期完全一致(节点删除 → 正文级联删除)。分成两个模块只会让
 * "谁能引用谁"多一层需要解释的约束。
 *
 * `RetentionService`(回收站保留策略,v2.4)也在这里 —— 它删的就是节点,
 * 而且要复用 `NodeService.purgeSubtree`。放到独立模块只会多一层导出。
 *
 * 不 import `AuditModule`:审计写入是纯函数(`audit/record.ts`)。
 */
@Module({
  imports: [PermissionModule],
  controllers: [NodeController],
  providers: [NodeService, ContentService, RetentionService],
  exports: [NodeService, ContentService, RetentionService],
})
export class NodeModule {}
