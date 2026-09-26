import { Module } from '@nestjs/common';

import { SpaceModule } from '../space/space.module.js';
import { PageController } from './page.controller.js';
import { PageService } from './page.service.js';

/**
 * 页面树模块。
 *
 * 依赖 SpaceModule 是为了复用它的 `requireCapability` —— 空间级权限判定
 * 只应该有一处实现。页面模块自己再写一遍的话,迟早有一处会漏掉
 * 超管直通或「最小可见」的 NOT_FOUND 语义,而那种缺失不会报错。
 *
 * 页面级权限(§5.2 沿路径回溯)是 M5 的事,本模块暂不涉及。
 */
@Module({
  imports: [SpaceModule],
  controllers: [PageController],
  providers: [PageService],
  exports: [PageService],
})
export class PageModule {}
