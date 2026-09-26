/**
 * 权限判定 —— DESIGN.md §5 的落地实现。
 *
 * ⚠️ **v2.0 起本文件整体重写。** 旧版是「五档角色 + 逐层继承 + deny 优先」,
 * 现在是「三种关系 + 三个判定问题」。没有角色等级,没有 deny,也没有「最小可见」。
 *
 * 整个模型只有三个概念(§5.1):
 *   - **所有者**(owner):每个节点必有且仅有一个。部门=部长,二级=部长任命,更深=创建者
 *   - **组织归属**(assignment):某人在组织里的位置,多归属
 *   - **显式授权**(grant):所有者单独放开给某个人
 *
 * 判定只有四个**纯函数**,全部零 IO —— 数据由调用方查好传进来。
 * 这是刻意的:权限判定属于「错了不会立刻报错」的高危逻辑,必须能被单测整体覆盖。
 */

/** 判定链上的一环。只带判定需要的字段。 */
export interface ChainNode {
  id: string;
  ownerId: string;
  title: string;
  depth: number;
}

/**
 * 判定上下文。由物化路径**一次查出**(根 → 自身),不做递归查询。
 *
 * 顺序约定:`ancestors` 从**根**开始、到自身的父节点结束(即 depth 升序),
 * `self` 单独一项。判定逻辑不依赖顺序,但 UI 展示推导链时依赖它。
 */
export interface Chain {
  self: ChainNode;
  ancestors: readonly ChainNode[];
}

/** 操作者。 */
export interface Actor {
  id: string;
  isSuperAdmin: boolean;
}

/**
 * 能读吗?
 *
 * **回答永远是 `true`。** 读对所有登录用户开放(§5.3 规则一)。
 *
 * 之所以保留这个函数而不是在调用点写 `if (true)`,是为了让「读也要过判定」
 * 这件事在代码上**显式存在** —— 将来若真的要做保密,改动点集中在这里,
 * 而不是散落在几十个 controller 里。
 */
export function canRead(_actor: Actor, _chain: Chain): boolean {
  return true;
}

/**
 * 能改吗?满足任一即可(§5.2):
 *   1. 我是这个节点的所有者
 *   2. 我在祖先链的**任一**节点上是所有者 —— 即「A 建的东西,A 的领导、上层领导都能改」
 *   3. 我在这个节点的显式授权名单里
 *
 * ⚠️ 与旧模型正好相反:旧模型是「越靠下越具体,就近覆盖」,
 * 新模型是「**越靠上权限越大**」。这是个容易写反的地方。
 */
export function canEdit(
  actor: Actor,
  chain: Chain,
  grantedUserIds: ReadonlySet<string>,
): boolean {
  if (actor.id === chain.self.ownerId) return true;
  if (chain.ancestors.some((node) => node.ownerId === actor.id)) return true;
  return grantedUserIds.has(actor.id);
}

/**
 * 能管吗(决定这个节点还有谁能改)?
 *
 * = 我是这个节点的所有者,或我在祖先链上任一节点上是所有者。
 *
 * **被授权者不能管** —— 他只能改,不能转授。
 *
 * ⚠️ `canManage` 为真**还不够**:授权动作另受**组织范围约束**,见 `canGrantTo`。
 */
export function canManage(actor: Actor, chain: Chain): boolean {
  return actor.id === chain.self.ownerId || chain.ancestors.some((n) => n.ownerId === actor.id);
}

/**
 * 能在 `parent` 下面新建吗?
 *
 * **单独一条规则,不要和 `canEdit` 混用。** 一个组员对「后端组」节点本身
 * 没有 `canEdit`(他不是所有者、也不在祖先链上),但他**有权在它下面新建** ——
 * 新建出来的节点归他所有。
 *
 * `belongsToParentScope` = 该操作者是否归属在父节点的组织范围内(服务端查一次)。
 */
export function canCreateUnder(
  actor: Actor,
  parentChain: Chain,
  parentGrantedUserIds: ReadonlySet<string>,
  belongsToParentScope: boolean,
): boolean {
  return canEdit(actor, parentChain, parentGrantedUserIds) || belongsToParentScope;
}

/**
 * 能把编辑权授予 `targetUserId` 吗? —— §5.3 规则三。
 *
 * 除了 `canManage`,**被授权者还必须落在操作者的组织范围内**:
 *
 * ```
 * orgScope(user) = 该用户所有 org_assignments 指向的节点,及其全部后代
 * ```
 *
 * 这条防的是横向越权:组长不该能把权限给到别的部门的人。
 * 范围自下而上自然放大(部长的 orgScope 是整个部门),
 * **不需要单独维护「谁的权限更大」**。
 *
 * `targetInOperatorScope` 由服务端查一次算好 —— 本包保持零 IO。
 */
export function canGrantTo(args: {
  actor: Actor;
  chain: Chain;
  targetUserId: string;
  targetInOperatorScope: boolean;
}): boolean {
  if (!canManage(args.actor, args.chain)) return false;
  // 把自己列进名单没有意义(所有者本来就能改),但也不构成越权,允许。
  if (args.actor.id === args.targetUserId) return true;
  return args.targetInOperatorScope;
}

/**
 * 候选节点是否落在 `scopePath` 的子树里 —— 组织范围判定的纯函数部分。
 *
 * 用物化路径前缀判断,不递归查子孙:更便宜,也不可能漏。
 *
 * ⚠️ **前缀末尾的斜杠不能省**,否则 `/p-1` 会被误判为 `/p-10` 的祖先。
 * (这一条与 §8.1 的防环判定是同一个坑,已实测。)
 */
export function isWithinSubtree(candidatePath: string, scopePath: string): boolean {
  return candidatePath === scopePath || candidatePath.startsWith(`${scopePath}/`);
}
