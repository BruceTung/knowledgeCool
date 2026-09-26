import { SPACE_ROLES, type SpaceRole } from '@knowledgecool/shared';
import { IsIn } from 'class-validator';

/** 修改成员角色(DESIGN.md §6.2 `PATCH /spaces/:id/members/:userId`)。 */
export class UpdateSpaceMemberRoleDto {
  /**
   * 只允许 SPACE_ROLES 里的四个值。**不含 `none`** ——
   * 空间角色的语义是「在这个空间里是什么」,移除成员要走 DELETE 而不是设成 none。
   */
  @IsIn([...SPACE_ROLES], { message: '角色不合法' })
  role!: SpaceRole;
}
