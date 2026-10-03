/**
 * 授权名单 —— DESIGN.md §5.3 规则三 / §6.2。
 *
 * ⚠️ **只有加法,没有 deny。** 收回权限 = 把人从名单里删掉。
 * 不要为了「对称」补一个 deny 字段 —— 它会让判定逻辑重新长出分支,
 * 而分支正是这一版要消灭的东西。
 */

import { type UserStatus } from './org.js';

/** 名单里的一条。 */
export interface NodeGrantView {
  userId: string;
  name: string;
  employeeNo: string;
  /** 已离职 —— 前端标注出来,提示管理员可以考虑移除 */
  departed: boolean;
  grantedByName: string;
  grantedAt: string;
}

/**
 * 一个节点的完整权限视图。
 *
 * **三段的划分是刻意的**,UI 要分别回答「这些人为什么能改」:
 *   - 第 1 段:节点所有者 —— 自己就有权
 *   - 第 2 段:祖先链上的所有者 —— 有权是因为在链上,**不可移除**
 *   - 第 3 段:显式授权 —— 只有这一段可增删
 *
 * 如果不分段,管理员会试图去"移除"组长的权限(一个他删不掉的东西)。
 */
export interface NodeGrantsResponse {
  nodeId: string;
  owner: { userId: string; name: string; employeeNo: string; departed: boolean };
  inherited: {
    nodeId: string;
    title: string;
    ownerId: string;
    ownerName: string;
    departed: boolean;
  }[];
  grants: NodeGrantView[];
  /** 我能否增删这个名单 */
  canManage: boolean;
  version: number;
  /**
   * **本节点需要尽快换负责人**(v5.44)。
   *
   * ⚠️ 为什么要单独一个字段,而不让界面拿 `owner.departed` 自己推:
   * 「负责人离职」在这套模型里的后果比"少一个人"更严重 ——
   * `canManage` 是「本人是 ownerId」或「我在祖先链上是 ownerId」,
   * 所以**负责人离职之后,这条链上的整棵子树没有任何人改得了**
   * (他登不进来,而他的上级链条上如果也没有人,就直接卡死)。
   *
   * 而 `owner.departed` 只能表达"他走了",表达不了"所以现在这件事很急"。
   * 更要紧的是:**祖先链上的负责人离职同样致命**,而那在界面上
   * 只是一行 `inherited[]` 里的一个标签,不会有人注意到。
   * → 这个字段把"有个负责人位置现在是空的,且因此整棵子树被锁住"
   * 这件事**提到第一屏**,让它在打开弹窗的那一刻就说出来。
   */
  needsNewOwner: boolean;
  /** 需要换人的节点标题(取自最近的那个离职祖先),供文案直接使用 */
  vacatedBy?: { nodeId: string; title: string; ownerName: string } | null;
}

/** 保存授权名单 —— **整表替换**。 */
export interface SaveNodeGrantsInput {
  version: number;
  userIds: string[];
}

/**
 * 可授权的候选人。
 *
 * ⚠️ 服务端**已按操作者的组织范围过滤**(§5.3 规则三)。
 * 但前端拿到的这份过滤结果**只是便利,不是安全边界** ——
 * 写入时服务端会逐个再校验一次,越界直接拒绝。
 */
export interface GrantCandidate {
  userId: string;
  name: string;
  employeeNo: string;
  /** 他的组织归属路径,便于管理员判断。如 "技术部 / 后端组" */
  scopePaths: string[];
  /**
   * 账号状态(v5.44)。
   *
   * ⚠️ **为什么这个字段是必需的而不是锦上添花**:
   * 候选人列表原先在**类型层面**就无法表达"这个人已经离职",
   * 所以界面只能把他渲染成一个正常的可选项 ——
   * 管理员看不出谁走了,选中之后服务端才 400
   * 「不能把权限交给已停用或已离职的账号」。
   *
   * 那一句话是**写给开发者看的**,不是写给管理员看的。管理员在那个下拉框里
   * 唯一能做的就是"选一个看起来对的人",而离职的人看起来完全对。
   *
   * → 有它在,界面可以标注、可以置灰、可以不给他选中;
   * 没有它,任何"显示离职状态"的需求都要先改这个类型。
   */
  status: UserStatus;
}
