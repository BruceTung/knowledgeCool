import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

import { BULK_MOVE_MAX, type BulkMoveNodesInput } from '@knowledgecool/shared';

/**
 * 批量移动(v2.14)。
 *
 * ⚠️ 这里的 `ArrayMaxSize` 与 shared 的 `BULK_MOVE_MAX` 必须一致 ——
 * 所以它引用那个常量而不是再写一个字面量 50:两处各写一个数字,
 * 迟早有一处被改掉,而表现是"接口报的数量上限与文档不符"。
 */
export class BulkMoveDto implements BulkMoveNodesInput {
  @IsArray()
  @ArrayNotEmpty({ message: '请先选择要移动的节点' })
  @ArrayMaxSize(BULK_MOVE_MAX, {
    message: `一次最多移动 ${String(BULK_MOVE_MAX)} 个节点`,
  })
  @IsUUID('all', { each: true })
  nodeIds!: string[];

  @IsUUID()
  newParentId!: string;
}
