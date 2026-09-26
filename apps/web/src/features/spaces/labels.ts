/**
 * 角色的中文措辞 —— 成员列表、角色下拉、说明文案共用同一份。
 *
 * 之所以单独一个模块而不是写在组件里:这些词会出现在三个以上地方,
 * 散落着写迟早会不一致(「只读成员」和「只读」和「查看者」混用)。
 * 配一个测试盯着「每个角色都有标签」,将来加角色时不会漏。
 */
import { SPACE_ROLES, type SpaceRole } from '@knowledgecool/shared';

/** 角色名。与 DESIGN.md §5.4 的权限矩阵用词逐字一致。 */
export const ROLE_LABELS: Readonly<Record<SpaceRole, string>> = Object.freeze({
  admin: '空间管理员',
  editor: '编辑者',
  commenter: '评论者',
  viewer: '只读成员',
});

/** 一句话说明这个角色能做什么。用于下拉与成员列表的副标题。 */
export const ROLE_HINTS: Readonly<Record<SpaceRole, string>> = Object.freeze({
  admin: '管理成员与空间设置,可操作全部页面',
  editor: '可创建、编辑、删除页面',
  commenter: '可留言与 @提及,不能改动正文',
  viewer: '仅可浏览与导出',
});

/** 下拉选项。顺序取自 SPACE_ROLES(从高到低),不在这里另写一遍。 */
export const ROLE_OPTIONS: readonly { value: SpaceRole; label: string; hint: string }[] =
  SPACE_ROLES.map((role) => ({
    value: role,
    label: ROLE_LABELS[role],
    hint: ROLE_HINTS[role],
  }));
