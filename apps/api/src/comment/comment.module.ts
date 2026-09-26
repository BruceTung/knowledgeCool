import { Module } from '@nestjs/common';

import { PermissionModule } from '../permission/permission.module.js';
import { CommentController } from './comment.controller.js';
import { CommentService } from './comment.service.js';

/**
 * 页面级评论模块(DESIGN.md §8.4)。
 *
 * 依赖 PermissionModule 而不是 SpaceModule:评论的门槛是
 * 「对**这个页面**至少 commenter」,而页面级规则会把空间角色压下去 ——
 * 用空间角色判会让"被单独降权到只读的人"仍然能发言。
 */
@Module({
  imports: [PermissionModule],
  controllers: [CommentController],
  providers: [CommentService],
  exports: [CommentService],
})
export class CommentModule {}
