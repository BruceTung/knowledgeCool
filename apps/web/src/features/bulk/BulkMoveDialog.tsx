/**
 * 批量移动弹窗(v2.14)。
 *
 * ## 为什么是一个弹窗,而不是在组织树上做多选
 *
 * 树上做多选要改 `OrgTreePanel` —— 那是个 660 行、承载着整套键盘导航与 ARIA 的组件。
 * 为了一个低频操作(整理目录)去动它,风险与收益不成比例。
 * 而"把一个组里的几篇挪到另一个组"这个真实需求,在弹窗里反而更清楚:
 * 勾选是列表式的,目标是有路径的下拉,不会有"拖到哪儿去了"的歧义。
 *
 * 服务端那条「批量里不允许互为祖先」的规则,这里**提前算给用户看** ——
 * 而不是等他点提交再打回来。
 */
import { useMemo, useState } from 'react';

import { Modal } from '../../components/Modal';
import { Button, ErrorNote, SelectField } from '../../components/ui';
import { destinationCandidates, pathLabel, tidySelection } from '../../lib/bulk-move';
import { useModalOpen } from '../../lib/modal-store';
import { toast } from '../../lib/toast-store';
import { T_META } from '../../lib/typography';
import { useBulkMoveNodes, useOrgTree } from '../org/queries';
import { buildTree } from '../org/tree-utils';

export function BulkMoveDialog({
  parentId,
  title,
  onClose,
}: {
  /** 这个节点下的子节点参与选择 */
  parentId: string;
  title: string;
  onClose: () => void;
}) {
  useModalOpen();
  const tree = useOrgTree();
  const bulkMove = useBulkMoveNodes();

  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState('');

  const nodes = useMemo(() => buildTree(tree.data?.nodes ?? []), [tree.data]);
  const children = useMemo(() => {
    const walk = (list: readonly ReturnType<typeof buildTree>[number][]): typeof list => list;
    void walk;
    return (tree.data?.nodes ?? [])
      .filter((item) => item.parentId === parentId)
      .sort((a, b) => a.position - b.position);
  }, [tree.data, parentId]);

  const tidy = useMemo(() => tidySelection(nodes, selected), [nodes, selected]);
  const candidates = useMemo(() => destinationCandidates(nodes, tidy.kept), [nodes, tidy.kept]);

  return (
    <Modal
      title={`批量移动 · ${title}`}
      onClose={onClose}
      footer={
        <>
          <ErrorNote error={bulkMove.error} />
          <div className="flex-1" />
          <Button variant="secondary" className="flex-none" onClick={onClose}>
            取消
          </Button>
          <Button
            className="flex-none"
            disabled={tidy.kept.length === 0 || target === '' || bulkMove.isPending}
            onClick={() => {
              bulkMove.mutate(
                { nodeIds: tidy.kept, newParentId: target },
                {
                  onSuccess: () => {
                    toast(`已移动 ${String(tidy.kept.length)} 个节点`, 'success');
                    onClose();
                  },
                },
              );
            }}
          >
            {bulkMove.isPending ? '移动中…' : `移动 ${String(tidy.kept.length)} 个`}
          </Button>
        </>
      }
    >
      {/*
        ⚠️ v2.16 改文案:原来写「勾选这个节点下的内容」,而下面列的是
        `children` —— **只有直接子节点**,孙节点一个都不出现。
        用户会以为"内容不全"是 bug(而它其实是刻意的:批量移动一步一层,
        要动孙节点就进到它父节点那一层去操作)。文案现在如实说明这一点。
      */}
      <p className="text-sm leading-relaxed text-slate-500">
        勾选要移动的内容,再选一个目标。这里列的是<b>直接子节点</b> ——
        孙节点请进它父节点那一层再移动。同一批里**只取最外层**:
        选了 A 又选它里面的 B 时,结果会取决于执行顺序,所以服务端会拒绝那种选法。
      </p>

      {children.length === 0 && (
        <p className="text-sm text-slate-500">这个节点下面还没有直接子节点。</p>
      )}

      <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200">
        {children.map((child) => (
          <label
            key={child.id}
            className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selected.includes(child.id)}
              onChange={(event) => {
                setSelected((prev) =>
                  event.target.checked ? [...prev, child.id] : prev.filter((id) => id !== child.id),
                );
              }}
            />
            <span className="flex-none text-xs text-slate-500">
              {child.kind === 'space' ? '组' : '页'}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{child.title}</span>
          </label>
        ))}
      </div>

      {tidy.dropped.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          {tidy.dropped.map((item) => (
            <div key={item.id}>
              「{item.title}」不会单独移动 —— {item.reason}。
            </div>
          ))}
        </div>
      )}

      <div>
        <SelectField
          label="移动到"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        >
          <option value="">选择一个目标…</option>
          {candidates.map((node) => (
            <option key={node.id} value={node.id}>
              {pathLabel(nodes, node.id)}
            </option>
          ))}
        </SelectField>
        <p className={`mt-1 text-slate-500 ${T_META}`}>
          下拉里不会出现选中项自己和它的子孙 —— 移到那些地方会让树成环。
        </p>
      </div>
    </Modal>
  );
}
