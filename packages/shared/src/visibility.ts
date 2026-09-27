/**
 * 受限节点的读者名单 —— v2.12 的保密能力。
 *
 * ## 与 `grant.ts` 的关系:形状相似,机制刻意分开
 *
 * `grant.ts` 管「**能改**」,`visibility.ts` 管「**能读**」。两张表、两条接口、
 * 两套门槛。用户的原话是「创建者单独授权,不复用」,理由也成立:
 * 合并之后,「把某人加进编辑名单」与「让某人看得见」会共用一条路径,
 * 而**误加一次就是一次泄露** —— 分开之后两条路径能各自收紧。
 */
import type { NodeVisibility } from './node.js';
import type { NodeAccessLists } from './permission.js';

/** 读者名单里的一条。 */
export interface NodeReaderView {
  userId: string;
  name: string;
  employeeNo: string;
  /** 已离职 —— 前端标注出来,提示管理员可以考虑移除 */
  departed: boolean;
  grantedByName: string;
  grantedAt: string;
}

/**
 * 一个节点的可见性 + 读者名单视图。
 *
 * `inheritedFrom` 是界面上最容易被误解的一点:一个节点显示"受限",
 * 但所有者可能从没在这里设过 —— 限制是从**祖先**继承下来的。
 * 不说明的话,管理员会在这个节点上反复尝试把它改回公开,而那是做不到的
 * (只能去祖先那一层改)。所以接口直接把"限制来自哪"告诉前端。
 */
export interface NodeReadersResponse {
  nodeId: string;
  /** 这个节点**自己**的可见性(不含继承) */
  visibility: NodeVisibility;
  readers: NodeReaderView[];
  /** 我能否改这个名单 —— 创建者或所有者链(见 canManageReaders) */
  canManage: boolean;
  version: number;
  /** 祖先链上离它最近的受限节点;没有则为 null。界面据此解释「限制是继承来的」 */
  inheritedFrom: { nodeId: string; title: string } | null;
}

/** 保存可见性与读者名单 —— **整表替换**(与授权名单同一套约定)。 */
export interface SaveNodeReadersInput {
  version: number;
  /** 省略表示不改可见性 */
  visibility?: NodeVisibility;
  userIds: string[];
}

/**
 * 候选读者。
 *
 * 形状与 `GrantCandidate` 一样,但**刻意不复用那个类型**:将来给读者候选
 * 加一个字段(例如"他为什么可见")时,不该顺手改到编辑候选上去。
 */
export interface ReaderCandidate {
  userId: string;
  name: string;
  employeeNo: string;
  /** 他的组织归属路径,便于管理员判断。如 "技术部 / 后端组" */
  scopePaths: string[];
}

// ============================================================
// 树的保密过滤(v2.14 从 NodeService 里搬过来的纯逻辑)
// ============================================================
//
// 为什么搬进 shared:这段判定**错了不会报错** —— 表现是「某一层的标题被不该看见的人看见了」,
// 而界面、接口、日志一切正常。它是这个系统里最需要被测的逻辑之一,而它原本嵌在
// NodeService.tree 的方法体里(要连着 Prisma 一起 mock 才能测)。搬成纯函数之后,
// 前后端与单测都能直接用它,见 packages/shared/test/visibility.spec.ts。

/** 参与判定的节点字段。刻意只要这几列 —— 判定不该依赖标题、正文之类的业务字段。 */
export interface ReadableNode {
  id: string;
  parentId: string | null;
  ownerId: string;
  /** 库里的原始字符串,由本函数收敛(不用调用方先转,免得漏一处) */
  visibility: string;
}

/**
 * 算出「这些节点里,这个人能读到哪些」。
 *
 * ## 三条规则
 *
 * 1. **父节点读不到,子节点一定读不到。** 这就是「子树继承」的实现处。
 *    只摘掉受限节点自己是不够的:那样别人仍然能看到它下面子节点的标题,
 *    而子标题往往就够泄露信息了(父节点叫什么不重要,重要的是「Q4 裁员名单」那个标题)。
 * 2. 受限节点对**所有者链**(自己或任一祖先的所有者)放行。
 * 3. 受限节点对**名单**放行:读者名单,或者编辑被授权者。
 *    少了后半句会出现「能改但不能看」—— 他打开文档是空白,只会被当成 bug 报上来。
 *
 * ⚠️ 判定走**完整祖先链**,不是只看自己那一层。逐层看的话,
 * 「受限的父节点下挂一个 public 的子节点」会对全员可见 —— 保密形同虚设。
 *
 * @param actorId 当前用户
 * @param nodes   参与判定的节点(**必须包含判定范围的全部祖先**)
 * @param listsByNode 受限节点的两张名单:id → { readers, grantees }
 * @returns 可读节点 id 的集合
 */
export function readableNodeIds(
  actorId: string,
  nodes: readonly ReadableNode[],
  listsByNode: ReadonlyMap<string, NodeAccessLists>,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const decided = new Map<string, boolean>();

  /** 自己或任一祖先是不是这个人所有。递归往上走,走不到头就停。 */
  const ownsNodeOrAncestor = (start: ReadableNode): boolean => {
    let cursor: ReadableNode | undefined = start;
    // 上限只是防御性的:真成环了也不能把请求挂死
    for (let guard = 0; cursor !== undefined && guard < 1000; guard += 1) {
      if (cursor.ownerId === actorId) return true;
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    return false;
  };

  const isReadable = (id: string): boolean => {
    const cached = decided.get(id);
    if (cached !== undefined) return cached;

    const node = byId.get(id);
    // 查不到(理论上不会)不因为保密而隐藏 —— 保密是加法,不该顺手少给东西
    if (node === undefined) return true;

    const parentOk = node.parentId === null ? true : isReadable(node.parentId);
    let ok = parentOk;
    if (parentOk && node.visibility === 'restricted') {
      const lists = listsByNode.get(id);
      ok =
        ownsNodeOrAncestor(node) ||
        (lists?.readers.has(actorId) ?? false) ||
        (lists?.grantees.has(actorId) ?? false);
    }

    decided.set(id, ok);
    return ok;
  };

  const readable = new Set<string>();
  for (const node of nodes) {
    if (isReadable(node.id)) readable.add(node.id);
  }
  return readable;
}
