/**
 * 物化路径工具 —— 纯函数,零依赖。
 *
 * 路径形如 `/<祖先id>/.../<自身id>`。**三处地方都要用它,而且必须用同一套规则**:
 *   ① 权限判定(取祖先链)  ② 移动时防环  ③ 面包屑
 * 各写一份迟早会不一致 —— 而不一致的表现是静默越权,不会报错。
 */

/** 由一个 id 生成根路径。 */
export function pathOfRoot(id: string): string {
  return `/${id}`;
}

/** 在父路径下生成子节点路径。 */
export function pathOfChild(parentPath: string, id: string): string {
  return `${parentPath}/${id}`;
}

/**
 * 子树的 LIKE 前缀。
 *
 * ⚠️ **末尾的斜杠不能省** —— 否则 `/p-1` 会被当成 `/p-10` 的祖先。
 * 这一条与防环判定是同一个坑,已实测(见 DESIGN §8.1)。
 */
export function subtreePrefix(path: string): string {
  return `${path}/`;
}

/** 路径里含几层(根为 0)。 */
export function depthOfPath(path: string): number {
  return idsOfPath(path).length - 1;
}

/** 路径里的所有 id,从根到自身。 */
export function idsOfPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * 路径的全部前缀(含自身)—— 即「自身 + 所有祖先」的路径集合。
 *
 * 权限判定靠它**一次查完整条祖先链**,而不是逐级递归向上查。
 * 这是整棵树里唯一性能敏感的路径。
 */
export function prefixPathsOf(path: string): string[] {
  const ids = idsOfPath(path);
  return ids.map((_, index) => `/${ids.slice(0, index + 1).join('/')}`);
}

/**
 * 一级节点(部门)的 id。
 * 权限缓存的世代号按它分片 —— 组织变更天然以部门为边界。
 */
export function rootIdOfPath(path: string): string {
  return idsOfPath(path)[0] ?? '';
}

/** 把路径渲染成人类可读的 `技术部 / 后端组` 形式(需传入 id → 标题的映射)。 */
export function renderPath(path: string, titles: ReadonlyMap<string, string>): string {
  const names = idsOfPath(path).map((id) => titles.get(id) ?? id);
  return names.join(' / ');
}
