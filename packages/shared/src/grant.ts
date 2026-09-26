/**
 * 授权名单 —— DESIGN.md §5.3 规则三 / §6.2。
 *
 * ⚠️ **只有加法,没有 deny。** 收回权限 = 把人从名单里删掉。
 * 不要为了「对称」补一个 deny 字段 —— 它会让判定逻辑重新长出分支,
 * 而分支正是这一版要消灭的东西。
 */

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
}
