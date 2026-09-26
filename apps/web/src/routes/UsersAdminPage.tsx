import { USER_STATUS_LABELS, type OrgUserView, type UserStatus } from '@knowledgecool/shared';
import { useState } from 'react';

import { Button, ErrorNote, SelectField, TextField } from '../components/ui';
import {
  useCreateUser,
  useOrgScopes,
  useOrgUsers,
  useSetUserAssignments,
  useUpdateUser,
} from '../features/admin/queries';

/**
 * 人员管理(超管)。
 *
 * ⚠️ 三条必须在这里说清楚的事:
 *
 *   1. **建出来的账号初始密码是 `123456`**,首次登录会被强制改密。
 *      这不是可选的 —— 只发初始密码而不强制改,等于全员同密码上线(§6.1.2)。
 *   2. **删除人员在这里是"改状态",不是删账号**。离职要标 `departed`(不是
 *      `disabled`):前者是人事状态,后者是账号被封,而**只有前者**会让
 *      他留下过的内容旁显示「已离职」。
 *   3. **归属决定授权范围**。一个人没有归属,他就既不能在别人下面新建,
 *      也不能被授权 —— 所以组织架构与人员是同一件事的两面。
 */
const STATUS_OPTIONS: readonly UserStatus[] = ['active', 'disabled', 'departed'];

function AssignmentsEditor({ user }: { user: OrgUserView }) {
  const scopes = useOrgScopes();
  const save = useSetUserAssignments();
  const [draft, setDraft] = useState<string[] | null>(null);

  const options = scopes.data ?? [];
  const optionIds = new Set(options.map((scope) => scope.nodeId));

  /**
   * 草稿从**服务端给的 id** 初始化,不用路径文本去匹配 ——
   * 保存是**整表替换**,匹配漏一条就是静默地删掉他的一条归属。
   */
  const selected = new Set(draft ?? user.scopeNodeIds);

  /**
   * 有归属挂在这个界面表达不了的节点上(例如三级子空间)。
   *
   * ⚠️ 必须显式提示:一保存就会把它们**删掉**,而且不会有任何报错。
   * 这类"悄悄丢数据"的交互是最坏的一种,所以宁可在界面上把话说明白。
   */
  const outsideIds = user.scopeNodeIds.filter((id) => !optionIds.has(id));
  const outsidePaths = user.scopePaths.filter((_, index) => {
    const id = user.scopeNodeIds[index];
    return id !== undefined && !optionIds.has(id);
  });

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] text-slate-500">
        勾选他所属的部门 / 组。可多选 —— 一个人可以同属多个组或项目。
      </div>

      {outsideIds.length > 0 && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
          他还有 {outsideIds.length} 条归属挂在这张列表之外的节点上
          {outsidePaths.length > 0 && `(${outsidePaths.join('、')})`}。
          <b>这里保存会把这些归属删掉</b> —— 因为它们不在可选项里,而保存是整表替换。
        </div>
      )}

      <div className="mt-2 max-h-40 space-y-1 overflow-auto">
        {options.map((scope) => (
          <label key={scope.nodeId} className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={selected.has(scope.nodeId)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(scope.nodeId);
                else next.delete(scope.nodeId);
                setDraft([...next]);
              }}
            />
            {scope.path}
          </label>
        ))}
        {options.length === 0 && (
          <p className="text-xs text-slate-400">还没有任何组织节点,先去「组织架构」建部门。</p>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button
          disabled={draft === null || save.isPending}
          onClick={() => {
            const next = draft ?? [];
            if (
              outsideIds.length > 0 &&
              !window.confirm(
                `保存会删掉 ${String(outsideIds.length)} 条不在候选里的归属,确定继续?`,
              )
            ) {
              return;
            }
            save.mutate(
              { userId: user.id, nodeIds: next },
              {
                onSuccess: () => {
                  setDraft(null);
                },
              },
            );
          }}
        >
          保存归属
        </Button>
        <span className="text-[11px] text-slate-400">已选 {selected.size} 条</span>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

export function UsersAdminPage() {
  const [query, setQuery] = useState('');
  const users = useOrgUsers(query);
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();

  const [employeeNo, setEmployeeNo] = useState('');
  const [name, setName] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-8 py-8">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">人员管理</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          人员是<b>预置</b>的,不是自行注册的。几百人请用「组织架构 → 下载模板」批量导入,
          这里适合零星加人或单人调整。
        </p>
      </div>

      {/* ---------------- 建人 ---------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-900">新建人员</h2>
        <p className="mt-1 text-xs text-slate-500">
          初始密码固定为 <code className="rounded bg-slate-100 px-1">123456</code>,
          对方首次登录会被要求改成「8 位以上且同时含字母与数字」的密码。
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[160px] flex-1">
            <TextField
              label="工号"
              value={employeeNo}
              onChange={(event) => {
                setEmployeeNo(event.target.value);
              }}
              placeholder="例如 KC2026001"
              hint="登录标识,定下来之后不要改"
            />
          </div>
          <div className="min-w-[140px] flex-1">
            <TextField
              label="姓名"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <Button
            className="flex-none"
            disabled={employeeNo.trim() === '' || name.trim() === '' || createUser.isPending}
            onClick={() => {
              createUser.mutate(
                { employeeNo: employeeNo.trim(), name: name.trim() },
                {
                  onSuccess: () => {
                    setEmployeeNo('');
                    setName('');
                  },
                },
              );
            }}
          >
            新建
          </Button>
        </div>
        <ErrorNote error={createUser.error} />
      </section>

      {/* ---------------- 人员列表 ---------------- */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-medium text-slate-900">人员 · {users.data?.length ?? 0}</h2>
          <div className="flex-1" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="按工号或姓名搜索"
            className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
          />
        </div>

        {users.isPending && <p className="px-4 py-6 text-xs text-slate-400">加载中…</p>}
        {users.isError && (
          <div className="px-4 py-3">
            <ErrorNote error={users.error} />
          </div>
        )}

        <ul className="divide-y divide-slate-100">
          {(users.data ?? []).map((user) => (
            <li key={user.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-28 flex-none font-mono text-xs text-slate-500">
                  {user.employeeNo}
                </span>

                {renamingId === user.id ? (
                  <input
                    autoFocus
                    defaultValue={user.name}
                    className="w-32 rounded border border-blue-400 px-1 py-0.5 text-sm outline-none"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        const next = event.currentTarget.value.trim();
                        if (next !== '' && next !== user.name) {
                          updateUser.mutate({ userId: user.id, name: next });
                        }
                        setRenamingId(null);
                      }
                      if (event.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next !== '' && next !== user.name) {
                        updateUser.mutate({ userId: user.id, name: next });
                      }
                      setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-24 flex-1 text-left text-sm text-slate-900 hover:underline"
                    onClick={() => {
                      setRenamingId(user.id);
                    }}
                    title="点击改姓名"
                  >
                    {user.name}
                  </button>
                )}

                {user.isSuperAdmin && (
                  <span className="rounded bg-violet-50 px-1 text-[10px] text-violet-700 ring-1 ring-violet-200">
                    管理员
                  </span>
                )}

                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
                  {user.scopePaths.length === 0 ? '未归属任何节点' : user.scopePaths.join('、')}
                </span>

                <span className="text-[11px] text-slate-400">
                  {user.lastLoginAt === null
                    ? '从未登录'
                    : `上次登录 ${new Date(user.lastLoginAt).toLocaleDateString('zh-CN')}`}
                </span>

                <div className="w-28 flex-none">
                  <SelectField
                    value={user.status}
                    aria-label="账号状态"
                    onChange={(event) => {
                      const status = event.target.value as UserStatus;
                      updateUser.mutate({ userId: user.id, status });
                    }}
                  >
                    {STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>
                        {USER_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </SelectField>
                </div>

                <Button
                  variant="secondary"
                  className="flex-none"
                  onClick={() => {
                    setExpandedId(expandedId === user.id ? null : user.id);
                  }}
                >
                  {expandedId === user.id ? '收起归属' : '设置归属'}
                </Button>
              </div>

              {expandedId === user.id && <AssignmentsEditor user={user} />}
            </li>
          ))}
        </ul>

        {users.data?.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-slate-400">
            没有匹配的人员。
          </p>
        )}
      </section>

      <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
        ⚠️ 这里的下拉是改<b>账号状态</b>:选「已离职」会立刻踢他下线,
        并在他留下的每篇内容旁显示「已离职」。<b>不会</b>删除账号 ——
        删了他写的文档会变成「佚名」,审计日志也会断链。
      </div>

      <ErrorNote error={updateUser.error} />
    </div>
  );
}
