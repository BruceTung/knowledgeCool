/**
 * 权限设置弹窗(DESIGN.md §5)。
 *
 * 这个弹窗要回答管理员最关心的一个问题:**这个人的权限到底是从哪来的?**
 * 所以除了规则列表,还必须显示「有效权限推导链」——
 * 只要一个最终角色值,管理员没法判断该改哪一层。
 *
 * ⚠️ UI 约定(§5.3,v1.5 定稿):
 * 「拒绝访问」写的是 `role='none'` + `deny=true`。
 * 前者用于显示,后者才是真正起作用的那个 —— deny 沿链**立即短路**,
 * 保证管理员点了"拒绝"之后,子页面的一条 allow 不能把它翻案。
 */
import {
  PAGE_RULE_ROLES,
  type EffectiveRole,
  type PageRuleRole,
  type PermissionSubjectCandidate,
  type SavePagePermissionsInput,
  type SubjectType,
} from '@knowledgecool/shared';
import { useMemo, useState } from 'react';

import { Button, ErrorNote, SelectField } from '../../components/ui';
import { usePagePermissions, usePermissionCandidates, useSavePermissions } from './queries';

/** 弹窗里一行可编辑的规则。`key` 用来在整表替换时去重。 */
interface DraftRule {
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  role: PageRuleRole;
  deny: boolean;
}

const ROLE_LABELS: Record<PageRuleRole, string> = {
  editor: '编辑者',
  commenter: '评论者',
  viewer: '只读成员',
  none: '拒绝访问',
};

const EFFECTIVE_LABELS: Record<EffectiveRole, string> = {
  admin: '空间管理员',
  editor: '编辑者',
  commenter: '评论者',
  viewer: '只读成员',
  none: '无权限',
};

export function PermissionsDialog({
  pageId,
  spaceId,
  onClose,
}: {
  pageId: string;
  spaceId: string;
  onClose: () => void;
}) {
  const permissions = usePagePermissions(pageId, true);
  const candidates = usePermissionCandidates(spaceId, true);
  const save = useSavePermissions(pageId, spaceId);

  /**
   * 草稿规则。
   *
   * `null` 表示「用户还没改过」,此时显示服务端的值 ——
   * 用一个状态而不是「拿到数据就 setState 灌进去」的 effect:
   * 后者会在每次重新取数时把手上的编辑冲掉,而且触发级联渲染。
   */
  const [edited, setEdited] = useState<DraftRule[] | null>(null);
  const [picker, setPicker] = useState('');

  const serverRules = useMemo<DraftRule[]>(
    () =>
      (permissions.data?.rules ?? []).map((rule) => ({
        subjectType: rule.subjectType,
        subjectId: rule.subjectId,
        label: rule.subjectLabel ?? rule.subjectId,
        role: rule.role,
        deny: rule.deny,
      })),
    [permissions.data],
  );

  const rules = edited ?? serverRules;

  /** 所有对规则的改动都走这里,保证 `edited` 一定被置为非 null。 */
  function updateRules(next: (prev: DraftRule[]) => DraftRule[]) {
    setEdited(next(rules));
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/30 p-8">
      <section className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">权限设置</h2>
            <p className="text-xs text-slate-500">
              {permissions.data?.pageTitle ?? '加载中…'}
            </p>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {permissions.isError && <ErrorNote error={permissions.error} />}
          {permissions.isPending && <p className="text-xs text-slate-400">加载中…</p>}

          {permissions.data !== undefined && (
            <>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">
                  当前我的有效角色:
                  <span className="ml-1 font-medium text-slate-800">
                    {EFFECTIVE_LABELS[permissions.data.myRole]}
                  </span>
                  {permissions.data.spaceRole !== null && (
                    <span className="ml-2 text-slate-400">
                      (空间角色:{EFFECTIVE_LABELS[permissions.data.spaceRole]})
                    </span>
                  )}
                </div>
              </div>

              <section className="mt-4">
                <h3 className="text-xs font-medium text-slate-600">有效权限推导链</h3>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  从根到本篇逐层判定。「拒绝访问」会立即中断,下面的层不会再被考虑。
                </p>
                <ol className="mt-2 space-y-1">
                  {permissions.data.chain.map((step) => (
                    <li
                      key={step.pageId}
                      className="flex items-center gap-2 rounded border border-slate-100 px-2 py-1.5 text-xs"
                    >
                      <span className="text-slate-300">{'·'.repeat(step.depth + 1)}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-600">
                        {step.pageTitle === '' ? '(无标题)' : step.pageTitle}
                      </span>
                      <span
                        className={
                          step.source === 'deny'
                            ? 'text-red-600'
                            : step.role === null
                              ? 'text-slate-400'
                              : 'text-slate-800'
                        }
                      >
                        {step.source === 'deny'
                          ? '拒绝访问(短路)'
                          : step.role === null
                            ? '继承'
                            : EFFECTIVE_LABELS[step.role]}
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between rounded border border-dashed border-slate-200 px-2 py-1.5 text-xs text-slate-400">
                    <span>空间兜底</span>
                    <span>
                      {permissions.data.spaceRole === null
                        ? '非成员'
                        : EFFECTIVE_LABELS[permissions.data.spaceRole]}
                    </span>
                  </li>
                </ol>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-medium text-slate-600">本页显式规则</h3>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  页面级只有编辑者 / 评论者 / 只读 / 拒绝;管理员是空间层面的角色,不能在这里授予。
                </p>

                <div className="mt-2 flex gap-2">
                  {/* ⚠️ 必须给 select 一个受约束的宽度容器:
                      它的样式里有 `w-full`,直接放在 flex 行里会去抢满整行,
                      把右边的按钮挤成两行("添 / 加")。 */}
                  <div className="min-w-0 flex-1">
                    <SelectField
                      value={picker}
                      onChange={(event) => setPicker(event.target.value)}
                      aria-label="选择要授权的成员或部门"
                    >
                      <option value="">选择成员或部门…</option>
                      {(candidates.data ?? []).map((candidate) => (
                        <option key={optionKey(candidate)} value={optionKey(candidate)}>
                          {candidate.subjectType === 'group'
                            ? `部门:${candidate.label}`
                            : candidate.label}
                          {candidate.memberCount === null
                            ? ''
                            : ` (${String(candidate.memberCount)} 人)`}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <Button
                    variant="secondary"
                    className="flex-none whitespace-nowrap"
                    disabled={picker === ''}
                    onClick={() => {
                      const candidate = (candidates.data ?? []).find(
                        (item) => optionKey(item) === picker,
                      );
                      if (candidate === undefined) return;
                      updateRules((prev) => {
                        if (
                          prev.some(
                            (rule) =>
                              rule.subjectId === candidate.subjectId &&
                              rule.subjectType === candidate.subjectType,
                          )
                        ) {
                          return prev;
                        }
                        return [
                          ...prev,
                          {
                            subjectType: candidate.subjectType,
                            subjectId: candidate.subjectId,
                            label: candidate.label,
                            role: 'viewer',
                            deny: false,
                          },
                        ];
                      });
                      setPicker('');
                    }}
                  >
                    添加
                  </Button>
                </div>

                <div className="mt-2 divide-y divide-slate-100 border-t border-slate-200">
                  {rules.length === 0 ? (
                    <p className="py-4 text-center text-xs text-slate-400">
                      还没有显式规则 —— 这篇完全按空间角色继承。
                    </p>
                  ) : (
                    rules.map((rule) => (
                      <div
                        key={`${rule.subjectType}:${rule.subjectId}`}
                        className="flex items-center gap-2 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-slate-800">{rule.label}</div>
                          <div className="text-[11px] text-slate-400">
                            {rule.subjectType === 'user' ? '单个成员' : '部门'}
                          </div>
                        </div>
                        {/* ⚠️ select 的样式里有 `w-full`,直接放在 flex 行里会抢满整行,
                            把左边的标签挤成「单/个/成/员」竖排、右边的按钮换行。
                            给它一个固定宽度的容器就解决了。 */}
                        <div className="w-32 flex-none">
                          <SelectField
                            value={rule.deny ? 'deny' : rule.role}
                            onChange={(event) => {
                              const value = event.target.value;
                              updateRules((prev) =>
                                prev.map((item) =>
                                  item.subjectId === rule.subjectId &&
                                  item.subjectType === rule.subjectType
                                    ? value === 'deny'
                                      ? { ...item, role: 'none', deny: true }
                                      : { ...item, role: value as PageRuleRole, deny: false }
                                    : item,
                                ),
                              );
                            }}
                          >
                            {PAGE_RULE_ROLES.filter((role) => role !== 'none').map((role) => (
                              <option key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </option>
                            ))}
                            <option value="deny">拒绝访问</option>
                          </SelectField>
                        </div>
                        <Button
                          variant="danger"
                          className="flex-none whitespace-nowrap"
                          onClick={() => {
                            updateRules((prev) =>
                              prev.filter(
                                (item) =>
                                  !(
                                    item.subjectId === rule.subjectId &&
                                    item.subjectType === rule.subjectType
                                  ),
                              ),
                            );
                          }}
                        >
                          移除
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                保存后服务端会立刻让本空间的权限缓存失效,已登录用户最迟 30 秒内生效。
              </p>

              {save.isError && (
                <div className="mt-3">
                  <ErrorNote error={save.error} />
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              const payload: SavePagePermissionsInput = {
                rules: rules.map((rule) => ({
                  subjectType: rule.subjectType,
                  subjectId: rule.subjectId,
                  role: rule.role,
                  deny: rule.deny,
                })),
              };
              save.mutate(payload, { onSuccess: onClose });
            }}
          >
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </footer>
      </section>
    </div>
  );
}

function optionKey(candidate: PermissionSubjectCandidate): string {
  return `${candidate.subjectType}:${candidate.subjectId}`;
}
