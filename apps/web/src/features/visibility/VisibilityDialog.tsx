/**
 * 可见范围弹窗(v2.13)—— DESIGN.md §5.6 的界面。
 *
 * ## 界面上必须说清的三件事
 *
 * 1. **默认是「公开」**。这一点要写出来,否则管理员会以为系统本来就该保密,
 *    于是把每篇文档都改成受限 —— 那会让知识库退化成"只有自己看得见"。
 * 2. **限制是继承的,而且只能往上改。** 一个节点显示"受限"时,限制可能来自
 *    某个祖先。不说明的话,管理员会在这里反复尝试改回公开,而那是做不到的。
 * 3. **受限 ≠ 只有名单里的人能看。** 所有者链与编辑被授权者本来就看得见 ——
 *    名单是**追加**的,不是全集。写清楚可以避免"我明明没加他,他怎么看得见"。
 */
import { USER_STATUS_LABELS } from '@knowledgecool/shared';
import { useState } from 'react';

import { Modal } from '../../components/Modal';
import { Button, ErrorNote, SelectField } from '../../components/ui';
import { useModalOpen } from '../../lib/modal-store';
import { toast } from '../../lib/toast-store';
import { T_META } from '../../lib/typography';
import { useReaderCandidates, useNodeReaders, useSaveReaders } from './queries';

export function VisibilityDialog({
  nodeId,
  title,
  onClose,
}: {
  nodeId: string;
  title: string;
  onClose: () => void;
}) {
  useModalOpen();

  const readers = useNodeReaders(nodeId);
  const save = useSaveReaders(nodeId);
  const canManage = readers.data?.canManage === true;
  const candidates = useReaderCandidates(nodeId, canManage);

  /** 本地草稿。null = 还没改过,提交时用服务端的值。 */
  const [draftVisibility, setDraftVisibility] = useState<'public' | 'restricted' | null>(null);
  const [draftIds, setDraftIds] = useState<string[] | null>(null);
  const [picker, setPicker] = useState('');

  const visibility = draftVisibility ?? readers.data?.visibility ?? 'public';
  const current = draftIds ?? (readers.data?.readers ?? []).map((row) => row.userId);
  const dirty = draftVisibility !== null || draftIds !== null;

  const byId = new Map((readers.data?.readers ?? []).map((row) => [row.userId, row]));
  const available = (candidates.data ?? []).filter((item) => !current.includes(item.userId));
  const inherited = readers.data?.inheritedFrom ?? null;

  function addReader(userId: string): void {
    setDraftIds([...current, userId]);
    setPicker('');
  }

  function removeReader(userId: string): void {
    setDraftIds(current.filter((id) => id !== userId));
  }

  return (
    <Modal
      title={`可见范围 · ${title}`}
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
            disabled={!canManage || !dirty || save.isPending}
            onClick={() => {
              if (readers.data === undefined) return;
              save.mutate(
                {
                  version: readers.data.version,
                  visibility: draftVisibility ?? undefined,
                  userIds: current,
                },
                {
                  onSuccess: () => {
                    setDraftVisibility(null);
                    setDraftIds(null);
                    toast('可见范围已更新', 'success');
                  },
                },
              );
            }}
          >
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {readers.isError && <ErrorNote error={readers.error} />}
      {readers.isPending && <p className="text-sm text-slate-500">加载中…</p>}

      {readers.data !== undefined && (
        <>
          {inherited !== null && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
              ⚠️ 限制是从上级继承来的 —— <b>{inherited.title}</b> 是受限的,
              所以这个节点及其子节点也受限。要放开,得去那一层改;在这里把它改成
              「公开」<b>不会生效</b>。
            </p>
          )}

          <div>
            <div className="mb-1 text-sm font-medium text-slate-700">可见性</div>
            <p className="mb-2 text-xs leading-relaxed text-slate-500">
              <b>公开</b>(默认):所有登录的同事都能看。知识库的价值在于共享,
              除非确有原因,否则请保持公开。
              <br />
              <b>受限</b>:只有所有者、被授权编辑的人、以及下面这份名单能看。
              <b>这个节点的所有子节点一并受限</b>。
            </p>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === 'public'}
                  disabled={!canManage}
                  onChange={() => {
                    setDraftVisibility('public');
                  }}
                />
                公开
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === 'restricted'}
                  disabled={!canManage}
                  onChange={() => {
                    setDraftVisibility('restricted');
                  }}
                />
                受限
              </label>
            </div>

            {!canManage && (
              <p className="mt-1 text-xs text-slate-500">
                只有这个节点的<b>创建者</b>或<b>所有者</b>能修改可见范围。
              </p>
            )}
          </div>

          {visibility === 'restricted' && (
            <div>
              <div className="mb-1 text-sm font-medium text-slate-700">
                读者名单 · {current.length}
              </div>
              <p className="mb-2 text-xs leading-relaxed text-slate-500">
                这份名单是<b>追加</b>的,不是全集 —— 所有者、以及被授权编辑的人
                本来就看得见,不用把他们加进来。
              </p>

              {current.length === 0 ? (
                <p className="text-xs text-slate-500">名单是空的,只有所有者与编辑被授权者能看。</p>
              ) : (
                current.map((userId) => {
                  const known = byId.get(userId);
                  return (
                    <div
                      key={userId}
                      className="flex items-center gap-2 border-t border-slate-100 px-1 py-2 first:border-t-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-slate-800">
                          {known?.name ?? '未知'}
                          {known?.departed === true && (
                            <span className={`ml-1 rounded bg-amber-50 px-1 text-amber-700 ring-1 ring-amber-200 ${T_META}`}>
                              {USER_STATUS_LABELS.departed}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {known?.employeeNo}
                          {known !== undefined && ` · 由 ${known.grantedByName} 加入`}
                        </div>
                      </div>
                      {canManage && (
                        <Button
                          variant="danger"
                          className="flex-none"
                          onClick={() => {
                            removeReader(userId);
                          }}
                        >
                          移除
                        </Button>
                      )}
                    </div>
                  );
                })
              )}

              {canManage && (
                <div className="mt-3 flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <SelectField
                      label="加人"
                      value={picker}
                      onChange={(event) => {
                        setPicker(event.target.value);
                      }}
                    >
                      <option value="">选择一个人…</option>
                      {available.map((item) => (
                        <option key={item.userId} value={item.userId}>
                          {item.name}({item.employeeNo})
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <Button
                    variant="secondary"
                    className="flex-none"
                    disabled={picker === ''}
                    onClick={() => {
                      addReader(picker);
                    }}
                  >
                    添加
                  </Button>
                </div>
              )}

              {canManage && candidates.data?.length === 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  没有可加的人 —— 候选人只包含在职账号。
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
