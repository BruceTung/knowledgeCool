/**
 * 节点成员弹窗(v2.4)—— DESIGN.md §8.5「调岗两步」的第二步。
 *
 * ## 它补的是哪个洞
 *
 * Excel 导入是**增量**语义:表格里没写,和"要删掉这条归属"无法区分。
 * 所以调岗一直是两步 —— 导入新归属 + 把旧归属删掉。而在 v2.4 之前,
 * 第二步只能到「人员管理 → 设置归属」整表替换:**看不到"这个节点下都有谁"**,
 * 只能对着一个人的全部归属做整体覆盖。这个弹窗就是那一步。
 *
 * ## 三条刻意的设计
 *
 * 1. **分成「直接成员」与「下属成员」两段**。只有直接归属在这个节点上的人
 *    能从这里移出;子孙节点上的人要移出,得到对应子孙那一层去操作。
 *    不分段的话,管理员会试图"从技术部移出后端组的人" —— 那件事应该
 *    在后端组做,在技术部做等于绕过了一层。
 *
 * 2. **每个人都要显示他在别处的归属**。移出一条归属**不是**把人清出公司,
 *    界面不写清楚的话,管理员会以为自己做了件很严重的事(或者反之)。
 *
 * 3. **移出前把后果说透**。移出归属不改变所有权(他可能仍是组长),
 *    但会**缩小他的组织范围** —— 他能授权给别人的人变少了。
 *    这两句必须出现在确认框里,否则"我把他移出去了,怎么他还能改"会变成
 *    一个反复出现的困惑。
 */
import { USER_STATUS_LABELS, type NodeMemberView } from '@knowledgecool/shared';
import { useState } from 'react';

import { Modal } from '../../components/Modal';
import { Button, ErrorNote, SelectField } from '../../components/ui';
import { useModalOpen } from '../../lib/modal-store';
import { T_META } from '../../lib/typography';
import { useAddNodeMember, useMemberCandidates, useNodeMembers, useRemoveNodeMember } from './queries';
import { describeRemoval } from './removal-note';

function StatusBadge({ status }: { status: NodeMemberView['status'] }) {
  if (status === 'active') return null;
  const tone =
    status === 'departed'
      ? 'bg-amber-50 text-amber-700 ring-amber-200'
      : 'bg-slate-100 text-slate-500 ring-slate-200';
  return (
    <span className={`ml-1 rounded px-1 ring-1 ${tone} ${T_META}`}>
      {USER_STATUS_LABELS[status]}
    </span>
  );
}

/** 一行「人」。`onRemove` 为空表示这一段只读。 */
function MemberRow({
  member,
  showPaths,
  onRemove,
  removing,
}: {
  member: NodeMemberView;
  showPaths: string[];
  onRemove?: (() => void) | undefined;
  removing: boolean;
}) {
  return (
    <div className="flex items-start gap-2 border-t border-slate-100 px-1 py-2 first:border-t-0">
      <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-100 text-sm text-slate-600">
        {member.name.slice(0, 1)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-800">
          {member.name}
          <StatusBadge status={member.status} />
          {member.isOwnerHere && (
            <span className={`ml-1 rounded bg-blue-50 px-1 text-blue-700 ring-1 ring-blue-200 ${T_META}`}>
              本节点所有者
            </span>
          )}
          {!member.isOwnerHere && member.isAncestorOwner && (
            <span className={`ml-1 rounded bg-violet-50 px-1 text-violet-700 ring-1 ring-violet-200 ${T_META}`}>
              上级所有者
            </span>
          )}
        </div>

        <div className="truncate text-xs text-slate-500">
          {member.employeeNo}
          {showPaths.length > 0 && ` · ${showPaths.join('、')}`}
        </div>

        {member.otherPaths.length > 0 && (
          <div className="truncate text-xs text-slate-500">
            另有归属:{member.otherPaths.join('、')}
          </div>
        )}
      </div>

      {onRemove !== undefined && (
        <Button variant="danger" className="flex-none" disabled={removing} onClick={onRemove}>
          移出
        </Button>
      )}
    </div>
  );
}

export function MembersDialog({
  nodeId,
  title,
  onClose,
}: {
  nodeId: string;
  title: string;
  onClose: () => void;
}) {
  useModalOpen();

  const members = useNodeMembers(nodeId);
  const canManage = members.data?.canManage === true;
  const candidates = useMemberCandidates(nodeId, canManage);
  const add = useAddNodeMember(nodeId);
  const remove = useRemoveNodeMember(nodeId);

  const [picker, setPicker] = useState('');

  const direct = members.data?.direct ?? [];
  const inherited = members.data?.inherited ?? [];
  const directIds = new Set(direct.map((member) => member.userId));

  const addable = (candidates.data ?? []).filter(
    (candidate) => !directIds.has(candidate.userId),
  );

  return (
    <Modal
      title={`成员 · ${title}`}
      onClose={onClose}
      footer={
        <>
          <p className="flex-1 text-xs leading-relaxed text-slate-500">
            调岗 = 在这里把人加进新节点 → 再到原节点把他移出。两步都要做。
          </p>
          <Button variant="secondary" className="flex-none" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
          {members.isError && <ErrorNote error={members.error} />}
          {members.isPending && <p className="text-sm text-slate-500">加载中…</p>}

          {members.data !== undefined && (
            <>
              {/* ---------- 第 1 段:直接成员 ---------- */}
              <div>
                <div className="mb-1 text-sm font-medium text-slate-700">
                  直接成员 · {direct.length}
                </div>
                <p className="mb-2 text-xs leading-relaxed text-slate-500">
                  他们的<b>组织归属</b>直接挂在这个节点上。这里管的是归属,
                  不是权限 —— 归属决定"他能授权给谁",权限在另一个弹窗里。
                </p>

                {direct.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    还没有人归属在这个节点上。
                  </p>
                ) : (
                  direct.map((member) => (
                    <MemberRow
                      key={member.userId}
                      member={member}
                      showPaths={member.memberPaths}
                      removing={remove.isPending}
                      onRemove={
                        canManage
                          ? () => {
                              if (!window.confirm(describeRemoval(member, title))) return;
                              remove.mutate(member.userId);
                            }
                          : undefined
                      }
                    />
                  ))
                )}

                {canManage && (
                  <div className="mt-3 flex gap-2">
                    <SelectField
                      value={picker}
                      onChange={(event) => {
                        setPicker(event.target.value);
                      }}
                      aria-label="选择要加入的人"
                    >
                      <option value="">添加成员…</option>
                      {addable.map((candidate) => (
                        <option key={candidate.userId} value={candidate.userId}>
                          {candidate.name}({candidate.employeeNo})
                        </option>
                      ))}
                    </SelectField>
                    <Button
                      className="flex-none"
                      disabled={picker === '' || add.isPending}
                      onClick={() => {
                        add.mutate(
                          { userId: picker },
                          {
                            onSuccess: () => {
                              setPicker('');
                            },
                          },
                        );
                      }}
                    >
                      加入
                    </Button>
                  </div>
                )}

                {canManage && candidates.isSuccess && addable.length === 0 && (
                  <p className="mt-1 text-xs text-slate-500">
                    没有可加入的人 —— 只能加你组织范围内、且尚未归属在这里的在职同事。
                  </p>
                )}
                <ErrorNote error={add.error ?? remove.error} />
              </div>

              {/* ---------- 第 2 段:下属成员 ---------- */}
              <div>
                <div className="mb-1 text-sm font-medium text-slate-700">
                  下属成员 · {inherited.length}
                </div>
                <p className="mb-2 text-xs leading-relaxed text-slate-500">
                  他们归属在这个节点<b>下面的</b>节点上(这个部门的各个组)。
                  <b>不能在这里移出</b> —— 请到他们所属的那个节点上去操作。
                </p>
                {inherited.length === 0 ? (
                  <p className="text-xs text-slate-500">下属节点里还没有人。</p>
                ) : (
                  inherited.map((member) => (
                    <MemberRow
                      key={member.userId}
                      member={member}
                      showPaths={member.memberPaths}
                      removing={false}
                    />
                  ))
                )}
              </div>
            </>
          )}
    </Modal>
  );
}
