/**
 * 节点权限弹窗(DESIGN.md §5.3 / §7.2)。
 *
 * 与 v1.x 的「权限设置」有三处本质差别,UI 必须把它体现出来:
 *
 *   1. **没有"拒绝访问"**。收回权限 = 把人从名单里删掉。旧版本那个
 *      `deny` 开关连同它的语义一起废除了。
 *   2. **三段分开显示**。所有者与祖先链上的所有者**不可在此移除** ——
 *      他们有权不是因为你授权了,而是因为模型就是这么定的。
 *      不分开的话,管理员会反复尝试去"移除"部长,而按钮根本不该存在。
 *   3. **候选人是被过滤过的**。服务端只返回操作者组织范围内的人(§5.3 规则三),
 *      组长看不到别的部门的人 —— 这不是前端藏的,是服务端就没给。
 */
import type { GrantCandidate, NodeGrantView } from '@knowledgecool/shared';
import { useState } from 'react';

import { Button, ErrorNote, SelectField } from '../../components/ui';
import { useModalOpen } from '../../lib/modal-store';
import { T_BADGE } from '../../lib/typography';
import { useMe } from '../auth/queries';
import { useOwnerCandidates, useSetOwner } from '../admin/queries';
import { useGrantCandidates, useNodeGrants, useSaveGrants } from './queries';

function DepartedBadge() {
  return (
    <span className={`ml-1 rounded bg-amber-50 px-1 text-amber-700 ring-1 ring-amber-200 ${T_BADGE}`}>
      已离职
    </span>
  );
}

/** 一行「人」。三段共用同一套视觉,差别只在右侧有没有移除按钮。 */
function PersonRow({
  name,
  employeeNo,
  scopePaths,
  departed,
  note,
  onRemove,
}: {
  name: string;
  employeeNo: string;
  scopePaths?: string[];
  departed?: boolean;
  note?: string;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-slate-100 px-1 py-2 first:border-t-0">
      <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-100 text-xs text-slate-600">
        {name.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-slate-800">
          {name}
          {departed === true && <DepartedBadge />}
        </div>
        <div className="truncate text-[11px] text-slate-400">
          {employeeNo}
          {scopePaths !== undefined && scopePaths.length > 0 && ` · ${scopePaths.join('、')}`}
          {note !== undefined && ` · ${note}`}
        </div>
      </div>
      {onRemove !== undefined && (
        <Button variant="danger" className="flex-none" onClick={onRemove}>
          移除
        </Button>
      )}
    </div>
  );
}

export function GrantDialog({
  nodeId,
  title,
  onClose,
}: {
  nodeId: string;
  title: string;
  onClose: () => void;
}) {
  const me = useMe();
  const grants = useNodeGrants(nodeId);

  // 登记为"有一个模态开着"—— 全局的 Ctrl/Cmd + K 靠它避免重复叠加。
  useModalOpen();

  /** 能不能改这份授权名单 —— 只有所有者与祖先链上的所有者可以,被授权者不行。 */
  const canManage = grants.data?.canManage === true;
  /**
   * 能不能换所有者。比 `canManage` 多一种情况:**超管对一级部门**。
   * 部门的所有者就是部长,而任命部长是组织架构层面的动作,只有超管能做;
   * 如果不在这里放行,那个唯一能换部长的人在界面上就没有入口。
   * (服务端的规则与这里一致:`setOwner` 对一级节点要求超管。) */
  const isRoot = grants.data !== undefined && grants.data.inherited.length === 0;
  const canAppointOwner = canManage || (me.data?.user.isSuperAdmin === true && isRoot);
  const candidates = useGrantCandidates(nodeId, canManage);
  const owners = useOwnerCandidates(nodeId, canAppointOwner);
  const save = useSaveGrants(nodeId);
  const setOwner = useSetOwner(nodeId);

  /**
   * 草稿:`null` 表示「还没编辑过,按服务端给的显示」。
   *
   * 不把服务端结果直接灌进 state —— 那样保存后的重新取数会把手上的编辑冲掉。
   */
  const [draft, setDraft] = useState<NodeGrantView[] | null>(null);
  const [picker, setPicker] = useState('');
  const [ownerPicker, setOwnerPicker] = useState('');

  const rows = draft ?? grants.data?.grants ?? [];

  function addCandidate(candidate: GrantCandidate): void {
    if (rows.some((row) => row.userId === candidate.userId)) return;
    setDraft([
      ...rows,
      {
        userId: candidate.userId,
        name: candidate.name,
        employeeNo: candidate.employeeNo,
        departed: false,
        grantedByName: '（待保存）',
        grantedAt: new Date().toISOString(),
      },
    ]);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-slate-900/20 p-6 pt-16">
      <div className="absolute inset-0" onClick={onClose} role="presentation" />

      <section className="relative w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
            权限 · {title}
          </h2>
          <Button variant="secondary" className="flex-none" onClick={onClose}>
            关闭
          </Button>
        </header>

        <div className="max-h-[70vh] space-y-5 overflow-auto px-5 py-4">
          {grants.isError && <ErrorNote error={grants.error} />}
          {grants.isPending && <p className="text-xs text-slate-400">加载中…</p>}

          {grants.data !== undefined && (
            <>
              {/* ---------- 第 1 段:所有者 ---------- */}
              <div>
                <div className="mb-1 text-xs font-medium text-slate-700">所有者</div>
                <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                  每个节点都有且只有一个所有者。部门的所有者就是部长,组长由部长任命。
                </p>
                {canAppointOwner && !canManage && (
                  <p className="mb-2 text-[11px] leading-relaxed text-amber-700">
                    你是超级管理员,所以能换部长;但你不是这个部门的内容所有者,
                    下面的授权名单你改不了 —— 组织权限与内容权限是分开的两件事。
                  </p>
                )}
                <PersonRow
                  name={grants.data.owner.name}
                  employeeNo={grants.data.owner.employeeNo}
                  departed={grants.data.owner.departed}
                />
                {canAppointOwner && (
                  <div className="mt-2 flex gap-2">
                    <SelectField
                      value={ownerPicker}
                      onChange={(event) => setOwnerPicker(event.target.value)}
                      aria-label="选择新的所有者"
                    >
                      <option value="">更换所有者为…</option>
                      {(owners.data ?? []).map((candidate) => (
                        <option key={candidate.userId} value={candidate.userId}>
                          {candidate.name}（{candidate.employeeNo}）
                          {candidate.scopePaths.length > 0 && ` · ${candidate.scopePaths.join('、')}`}
                        </option>
                      ))}
                    </SelectField>
                    <Button
                      variant="secondary"
                      className="flex-none"
                      disabled={ownerPicker === '' || setOwner.isPending}
                      onClick={() => {
                        setOwner.mutate(ownerPicker, {
                          onSuccess: () => {
                            setOwnerPicker('');
                          },
                        });
                      }}
                    >
                      更换
                    </Button>
                  </div>
                )}
                <ErrorNote error={setOwner.error} />
              </div>

              {/* ---------- 第 2 段:祖先链上的所有者 ---------- */}
              <div>
                <div className="mb-1 text-xs font-medium text-slate-700">
                  上级所有者 · {grants.data.inherited.length}
                </div>
                <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                  他们能改这一篇,是因为在上级链上拥有所有权(例如部长对本部门的全部内容)。
                  <b>不能在这里移除</b> —— 要改变这一点只能调整组织架构或所有者。
                </p>
                {grants.data.inherited.length === 0 ? (
                  <p className="text-[11px] text-slate-400">这是顶层节点,没有上级所有者。</p>
                ) : (
                  grants.data.inherited.map((item) => (
                    <PersonRow
                      key={item.nodeId}
                      name={item.ownerName}
                      employeeNo=""
                      departed={item.departed}
                      note={`来自「${item.title}」`}
                    />
                  ))
                )}
              </div>

              {/* ---------- 第 3 段:显式授权 ---------- */}
              <div>
                <div className="mb-1 text-xs font-medium text-slate-700">
                  额外授权 · {rows.length}
                </div>
                <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                  只影响<b>这一个节点</b>,不会往下传。收回权限就把人从名单里移除 ——
                  没有"拒绝访问"这种设置。
                </p>

                {rows.length === 0 ? (
                  <p className="text-[11px] text-slate-400">还没有额外授权。</p>
                ) : (
                  rows.map((row) => (
                    <PersonRow
                      key={row.userId}
                      name={row.name}
                      employeeNo={row.employeeNo}
                      departed={row.departed}
                      note={`由 ${row.grantedByName} 添加`}
                      onRemove={
                        canManage
                          ? () => {
                              setDraft(rows.filter((item) => item.userId !== row.userId));
                            }
                          : undefined
                      }
                    />
                  ))
                )}

                {canManage && (
                  <div className="mt-2 flex gap-2">
                    <SelectField
                      value={picker}
                      onChange={(event) => setPicker(event.target.value)}
                      aria-label="选择要授权的人"
                    >
                      <option value="">选择要授权的人…</option>
                      {(candidates.data ?? [])
                        .filter((candidate) => !rows.some((row) => row.userId === candidate.userId))
                        .map((candidate) => (
                          <option key={candidate.userId} value={candidate.userId}>
                            {candidate.name}（{candidate.employeeNo}）
                            {candidate.scopePaths.length > 0 &&
                              ` · ${candidate.scopePaths.join('、')}`}
                          </option>
                        ))}
                    </SelectField>
                    <Button
                      variant="secondary"
                      className="flex-none"
                      disabled={picker === ''}
                      onClick={() => {
                        const candidate = (candidates.data ?? []).find(
                          (item) => item.userId === picker,
                        );
                        if (candidate === undefined) return;
                        addCandidate(candidate);
                        setPicker('');
                      }}
                    >
                      添加
                    </Button>
                  </div>
                )}
                {canManage && candidates.data?.length === 0 && (
                  <p className="mt-1 text-[11px] text-slate-400">
                    没有可授权的人 —— 只能授权给你组织范围内的人。
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-slate-200 px-5 py-3">
          <ErrorNote error={save.error} />
          <div className="flex-1" />
          <Button variant="secondary" className="flex-none" onClick={onClose}>
            取消
          </Button>
          <Button
            className="flex-none"
            disabled={!canManage || draft === null || save.isPending}
            onClick={() => {
              if (grants.data === undefined) return;
              save.mutate(
                { version: grants.data.version, userIds: rows.map((row) => row.userId) },
                { onSuccess: () => { setDraft(null); } },
              );
            }}
          >
            {save.isPending ? '保存中…' : '保存授权'}
          </Button>
        </footer>
      </section>
    </div>
  );
}
