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
 * 这是刻意的:权限判定属于「错了不会立刻报错」的高危逻辑,必须能被**独立地逐条读、逐条核**。
 */

import type { NodeVisibility } from './node.js';

/** 判定链上的一环。只带判定需要的字段。 */
export interface ChainNode {
  id: string;
  ownerId: string;
  title: string;
  depth: number;
  /** 这一环自己的可见性(v2.12)。判定「能读吗」要用它。 */
  visibility: NodeVisibility;
  /** 这一环的创建者(v2.12)。受限节点的读者名单由创建者与所有者维护。 */
  createdBy: string;
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

/** 某个节点上的两张名单 —— 判定「能读吗」时要一起看。 */
export interface NodeAccessLists {
  /** 读者名单(node_readers)。只在 restricted 节点上有意义。 */
  readers: ReadonlySet<string>;
  /** 编辑授权名单(node_grants)。能改的人**必须**也能读。 */
  grantees: ReadonlySet<string>;
}

/**
 * 能读吗?(v2.12 —— **它真的会返回 false 了**)
 *
 * v2.0 起这个函数一直返回 `true`,并留了一句「将来若真要做保密,改动点
 * 集中在这里」。v2.12 就是那个「将来」:用户要求加上保密能力。
 *
 * ## 规则
 *
 *   1. 链上(自身 + 全部祖先)**没有 restricted** → 可读。这是绝大多数节点。
 *   2. 链上有 restricted → 那些受限节点**每一个**都必须放行,整条链才可读。
 *   放行的四条路(满足任一):
 *        a. 我是它**或它某个祖先**的所有者(越靠上权限越大,与 canEdit 同一方向)
 *        b. 我是它的**创建者**
 *        c. 我在它的读者名单里,或者本来就是它的编辑被授权者
 *
 * ## 三处刻意的决定
 *   所以创建者**有权管理这个节点的可见范围**。若他反而读不到,会出现两件坏事:
 *   ① **能管一个自己看不见的东西的名单**;
 *   ② **永久把自己锁在外面** —— 设成受限且名单为空之后他读不到(404),
 *      也就再也调不动那个管理入口。真机上正是这样锁住的:
 *      `replaceReaders` 写完要用 `readersOverview` 组装响应,那一步 404,
 *      表现是**改动已生效但界面报错**,而修复只能进数据库。
 *
 * ## 两处刻意的决定
 *
 * · **必须逐个受限节点都放行,不能只看最近的那个。** 只看最近的话,
 *   「外层受限节点里再放一个更内层的受限节点」时,只在**外层**名单里的人
 *   会读到内层 —— 那是泄露。
 * · **编辑被授权者也放行(c 的后半句)。** 否则会出现「能改但不能看」,
 *   那不成立:能改的人打开文档就是空白,只会被当成 bug 报上来。
 *
 * @param listsByNode 调用方查好的名单表:节点 id → 两张名单。**只包含受限节点**即可
 *                   (非受限节点根本不查名单)。
 */
export function canRead(
  actor: Actor,
  chain: Chain,
  listsByNode: ReadonlyMap<string, NodeAccessLists>,
): boolean {
  // 根 → 自身。顺序无所谓,但按顺序走便于理解"祖先在 index 之前"。
  const lineage: readonly ChainNode[] = [...chain.ancestors, chain.self];

  for (let index = 0; index < lineage.length; index += 1) {
    const node = lineage[index];
    if (node === undefined || node.visibility !== 'restricted') continue;

    const ownsNodeOrAncestor =
      node.ownerId === actor.id ||
      lineage.slice(0, index).some((ancestor) => ancestor.ownerId === actor.id);
    if (ownsNodeOrAncestor) continue;

    // 创建者放行 —— 与 canManageReaders 对齐,否则"能管名单但读不到",
    // 而且他会把自己永久锁在外面(见上方说明)。
    if (node.createdBy === actor.id) continue;

    const lists = listsByNode.get(node.id);
    const listed =
      (lists?.readers.has(actor.id) ?? false) || (lists?.grantees.has(actor.id) ?? false);
    if (!listed) return false;
  }

  return true;
}

/**
 * 能管**读者名单**吗?(v2.12)
 *
 * 用户的要求是「创建者单独授权,不复用」—— 所以这里认**创建者**。
 * 同时认**所有者链**:所有者是内容责任人,而且少了这一条,
 * 创建者一旦离职,那个节点的读者名单就永久冻结(再也加不进人,也移不出人)。
 */
export function canManageReaders(actor: Actor, chain: Chain): boolean {
  if (actor.id === chain.self.createdBy) return true;
  return actor.id === chain.self.ownerId || chain.ancestors.some((n) => n.ownerId === actor.id);
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
