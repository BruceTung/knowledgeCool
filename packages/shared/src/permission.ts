/**
 * 权限规则解析 —— DESIGN.md §5.2 的**纯函数**实现。
 *
 * 为什么这部分放在 shared 而不是只放后端:
 * DESIGN.md §5.2 的 effectiveRole 伪代码里带数据库调用,没法直接测。
 * 但真正容易写错的「链式覆盖 / 拒绝优先」逻辑与数据库无关 ——
 * 把它抽成纯函数,就能用单元测试把四条铁律逐条钉死(M5 的验收要求:
 * 「权限矩阵里每一格都有对应的通过 / 拒绝测试」)。
 * 带 IO 的壳子留在 apps/api,负责取物化路径与规则、读写 Redis 缓存。
 *
 * 两条 DESIGN.md 未写明、实现时才暴露的语义,在此显式定义(见 DESIGN.md v1.2 变更记录):
 *   1. **同层多规则命中**(同一页面上既有直接授给用户的规则、又有部门规则):
 *      按「越具体越优先」—— user 规则强于 group 规则。
 *   2. **deny 的作用范围**:任一命中规则的 deny=true 即短路返回 `none`,
 *      不论它来自哪一层 —— 这就是 §5.3 的「拒绝优先,不受层级影响」。
 */

import { type EffectiveRole, type PageRuleRole, type SpaceRole, toEffectiveRole } from './roles.js';

export type SubjectType = 'user' | 'group';

/** 一条显式页面规则(对应 page_permissions 表的一行)。 */
export interface PermissionRule {
  subjectType: SubjectType;
  /** user 时为 users.id(uuid 字符串);group 时为部门名(users.department)。 */
  subjectId: string;
  role: PageRuleRole;
  deny: boolean;
}

/** 判定上下文。阶段一没有独立用户组表,用户组即 users.department。 */
export interface SubjectContext {
  userId: string;
  /** 该用户所属的部门名列表。为空数组表示不属于任何部门。 */
  departments: readonly string[];
}

/** 链上的一环:某个祖先页面(或自身)及其显式规则。 */
export interface ChainNode {
  pageId: string;
  /** 该节点上的显式规则。空数组表示「继承」,不是「无权」。 */
  rules: readonly PermissionRule[];
}

/** 超管判定出的有效角色。超管直通仍须由调用方写审计日志(§5.2)。 */
export const SUPER_ADMIN_EFFECTIVE_ROLE: EffectiveRole = 'admin';

/** 规则是否命中当前主体。 */
export function ruleMatches(rule: PermissionRule, ctx: SubjectContext): boolean {
  if (rule.subjectType === 'user') {
    return rule.subjectId === ctx.userId;
  }
  return ctx.departments.includes(rule.subjectId);
}

/**
 * 同一节点内多条命中规则的取优顺序:user 规则比 group 规则更具体。
 * 排序权重小的排前面,于是更具体的排在数组末尾 —— 恰好被「后写覆盖」选中。
 */
function bySpecificity(a: PermissionRule, b: PermissionRule): number {
  const weight = (rule: PermissionRule): number => (rule.subjectType === 'user' ? 1 : 0);
  return weight(a) - weight(b);
}

/**
 * 沿祖先链从粗到细解析有效角色。
 *
 * @param chain 必须是从**根到自身**排序的节点数组(顺序错了结果就全错)。
 *              api 侧由 `materialized_path` 一次查出并按 depth 升序返回。
 * @returns 命中的角色;整条链上没有显式规则时返回 `null`。
 *          `null` 的含义是「交给调用方回退到空间角色」,**不是**「无权」。
 */
export function resolveRoleAlongChain(
  chain: readonly ChainNode[],
  ctx: SubjectContext,
): EffectiveRole | null {
  let best: EffectiveRole | null = null;

  for (const node of chain) {
    const matched = node.rules.filter((rule) => ruleMatches(rule, ctx));
    if (matched.length === 0) continue;

    // 拒绝优先:本层只要有 deny 就短路 —— 不看向更细的层,也不回退空间角色。
    if (matched.some((rule) => rule.deny)) {
      return 'none';
    }

    // 就近覆盖:数组靠后的层更靠近自身,覆盖靠前的层。
    const winner = [...matched].sort(bySpecificity).at(-1);
    if (winner !== undefined) {
      best = toEffectiveRole(winner.role);
    }
  }

  return best;
}

/**
 * 完整判定:先走页面链,链上无任何显式规则才回退空间角色。
 *
 * @param spaceRole 调用方查到的空间角色;不是空间成员时传 `null`。
 */
export function effectiveRoleFrom(
  chain: readonly ChainNode[],
  ctx: SubjectContext,
  spaceRole: SpaceRole | null | undefined,
): EffectiveRole {
  const fromChain = resolveRoleAlongChain(chain, ctx);
  if (fromChain !== null) return fromChain;
  return toEffectiveRole(spaceRole);
}
