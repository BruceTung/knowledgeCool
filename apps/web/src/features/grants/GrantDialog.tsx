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
import { USER_STATUS_LABELS, type GrantCandidate, type NodeGrantView } from '@knowledgecool/shared';
import { useState } from 'react';

import { Modal } from '../../components/Modal';
import { Button, ErrorNote, SelectField, UserStatusBadge } from '../../components/ui';
import { useModalOpen } from '../../lib/modal-store';
import { useMe } from '../auth/queries';
import { useOwnerCandidates, useSetOwner } from '../admin/queries';
import { useGrantCandidates, useNodeGrants, useSaveGrants } from './queries';

/** 一行「人」。三段共用同一套视觉,差别只在右侧有没有移除按钮。 */
/** 状态徽章现在接受 `UserStatus` 而非布尔 —— 见 `UserStatusBadge` 的注释(为何抽成共用)。 */
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
      <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-100 text-sm text-slate-600">
        {name.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-800">
          {name}
          {departed === true && <UserStatusBadge status="departed" />}
        </div>
        <div className="truncate text-xs text-slate-500">
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
    <Modal
      title={`权限 · ${title}`}
      onClose={onClose}
      footer={
        <>
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
                {
                  onSuccess: () => {
                    setDraft(null);
                  },
                },
              );
            }}
          >
            {save.isPending ? '保存中…' : '保存授权'}
          </Button>
        </>
      }
    >
      {grants.isError && <ErrorNote error={grants.error} />}
      {grants.isPending && <p className="text-sm text-slate-500">加载中…</p>}

      {grants.data !== undefined && (
        <>
          {/* ---------- 第 1 段:所有者 ---------- */}
          <div>
            <div className="mb-1 text-sm font-medium text-slate-700">所有者</div>
            <p className="mb-2 text-xs leading-relaxed text-slate-500">
              每个节点都有且只有一个所有者。部门的所有者就是部长,组长由部长任命。
            </p>
            {canAppointOwner && !canManage && (
              <p className="mb-2 text-xs leading-relaxed text-amber-700">
                你是超级管理员,所以能换部长;但你不是这个部门的内容所有者, 下面的授权名单你改不了 ——
                组织权限与内容权限是分开的两件事。
              </p>
            )}
            <PersonRow
              name={grants.data.owner.name}
              employeeNo={grants.data.owner.employeeNo}
              departed={grants.data.owner.departed}
            />

            {/*
              ⚠️ v5.44:负责人空缺告警 —— 这条是本轮改动里**最该有的一条**。

              为什么它不能只是一个标签:`canManage` 是
              「本人是 ownerId」或「我在祖先链某环上是 ownerId」。
              负责人离职后他登不进来,那一环就是**空的** ——
              如果上面没有别的在职所有者,整棵子树没人改得了,
              而界面看不出任何异常:树照常渲染,节点点得开,
              只是这里有一个没人会主动看的灰色标签。

              → 所以它必须出现在**打开弹窗的第一眼**,而不是
              让人自己把「他离职了」和「所以我改不了」连起来。
            */}
            {(() => {
              /*
                ⚠️ 用 IIFE 取一次局部变量,而不是在 JSX 里写
                `grants.data.vacatedBy !== null && ...grants.data.vacatedBy.xxx` ——
                后者每次访问都重新收窄,TypeScript 无法把可选属性一路带下去
                (它要报 `possibly undefined`)。取一次就好,顺带也让这段更可读。
              */
              const vacated = grants.data.vacatedBy;
              if (!vacated) return null;
              return (
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800 ring-1 ring-amber-200">
                  <strong>
                    {vacated.nodeId === nodeId
                      ? `「${vacated.title}」的负责人 ${vacated.ownerName} 已离职`
                      : `上一级「${vacated.title}」的负责人 ${vacated.ownerName} 已离职`}
                  </strong>
                  ,这个节点及其下所有内容现在没有人能改。请尽快改派给在职人员。
                </p>
              );
            })()}
            {canAppointOwner && (
              <div className="mt-2 flex gap-2">
                <SelectField
                  value={ownerPicker}
                  onChange={(event) => setOwnerPicker(event.target.value)}
                  aria-label="选择新的所有者"
                >
                  <option value="">更换所有者为…</option>
                  {(owners.data ?? []).map((candidate) => (
                    <option
                      key={candidate.userId}
                      value={candidate.userId}
                      // 离职的人**不出现**在这个列表里(ownerCandidates 已按在职过滤),
                      // 所以这里只需要在"有归属"时提示 —— 让管理员知道这个人的分量。
                      // ⚠️ 别在这里再按 status 过滤一次:那会让"为什么没有他"
                      // 变成一个界面上无法回答的问题(后端已在传 status,
                      // 若这里过滤,界面上就只能看到一个空下拉框)。
                      disabled={candidate.status !== 'active'}
                    >
                      {candidate.name}（{candidate.employeeNo}）
                      {candidate.scopePaths.length > 0 && ` · ${candidate.scopePaths.join('、')}`}
                      {candidate.status !== 'active' &&
                        ` · ${USER_STATUS_LABELS[candidate.status]}`}
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
            <div className="mb-1 text-sm font-medium text-slate-700">
              上级所有者 · {grants.data.inherited.length}
            </div>
            <p className="mb-2 text-xs leading-relaxed text-slate-500">
              他们能改这一篇,是因为在上级链上拥有所有权(例如部长对本部门的全部内容)。
              <b>不能在这里移除</b> —— 要改变这一点只能调整组织架构或所有者。
            </p>
            {grants.data.inherited.length === 0 ? (
              <p className="text-xs text-slate-500">这是顶层节点,没有上级所有者。</p>
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
            <div className="mb-1 text-sm font-medium text-slate-700">额外授权 · {rows.length}</div>
            <p className="mb-2 text-xs leading-relaxed text-slate-500">
              只影响<b>这一个节点</b>,不会往下传。收回权限就把人从名单里移除 ——
              没有"拒绝访问"这种设置。
            </p>

            {rows.length === 0 ? (
              <p className="text-xs text-slate-500">还没有额外授权。</p>
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
                        {candidate.scopePaths.length > 0 && ` · ${candidate.scopePaths.join('、')}`}
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
              <p className="mt-1 text-xs text-slate-500">
                没有可授权的人 —— 只能授权给你组织范围内的人。
              </p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
