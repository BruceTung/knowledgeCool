import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { CommentController } from './comment.controller.js';
import { CommentService } from './comment.service.js';

/**
 * 页面级评论模块(DESIGN.md §5.4)。
 *
 * 依赖 `PermissionModule`:评论的门槛是「**能读这个节点**」(`requireRead`),
 * 而读判定只有 `PermissionService` 一个入口 —— 不在这里另写一套判断(§12)。
 * (旧实现按「空间角色 / 页面级规则」判,那套模型 v2.0 已整体作废。)
 */
@Module({
  imports: [PermissionModule],
  controllers: [CommentController],
  providers: [CommentService],
  exports: [CommentService],
})
export class CommentModule {}
