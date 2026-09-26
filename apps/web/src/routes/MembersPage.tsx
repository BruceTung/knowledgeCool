import type { SpaceRole } from '@knowledgecool/shared';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { avatarClass, Button, ErrorNote, SelectField, TextField } from '../components/ui';
import { ROLE_LABELS, ROLE_OPTIONS } from '../features/spaces/labels';
import {
  useAddMember,
  useMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from '../features/spaces/queries';

/**
 * 成员管理(DESIGN.md §7.2 的 `/s/:spaceId/members`)。
 *
 * 拆成外层 + 内层两个组件,是为了让内层拿到**确定的** spaceId 再调 hooks。
 * 否则要在每个 mutation 里写 `spaceId ?? ''`,拼出一个 `/spaces//members`
 * 这种能编译、但永远打不通的 URL。
 */
export function MembersPage() {
  const { spaceId } = useParams<{ spaceId: string }>();

  if (spaceId === undefined || spaceId === '') {
    return <p className="p-8 text-sm text-slate-500">缺少空间标识。</p>;
  }
  return <MembersView spaceId={spaceId} />;
}

function MembersView({ spaceId }: { spaceId: string }) {
  const members = useMembers(spaceId);
  const addMember = useAddMember(spaceId);
  const updateRole = useUpdateMemberRole(spaceId);
  const removeMember = useRemoveMember(spaceId);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [newRole, setNewRole] = useState<SpaceRole>('editor');

  const space = members.data?.space;
  // 服务端才是权限的唯一裁判;这里只用来决定要不要展示操作控件。
  const canManage = space?.role === 'admin';

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (trimmedEmail === '') return;

    addMember.mutate(
      {
        email: trimmedEmail,
        role: newRole,
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        ...(password === '' ? {} : { password }),
      },
      {
        onSuccess: () => {
          setEmail('');
          setName('');
          setPassword('');
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <nav className="text-xs text-slate-400">
        <Link to="/spaces" className="hover:text-slate-600">
          全部空间
        </Link>
        <span> / </span>
        {space !== undefined && (
          <>
            <Link to={`/s/${space.id}`} className="hover:text-slate-600">
              {space.name}
            </Link>
            <span> / </span>
          </>
        )}
        <span>成员管理</span>
      </nav>

      <h1 className="mt-2 text-xl font-semibold text-slate-900">
        {space === undefined ? '成员管理' : `${space.name} · 成员管理`}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        {space === undefined
          ? '正在加载…'
          : `共 ${String(space.memberCount)} 位成员。角色决定成员在本空间的默认权限。`}
      </p>

      {!canManage && members.isSuccess && (
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          你的角色是{ROLE_LABELS[space?.role ?? 'viewer']},只能查看成员列表。
        </p>
      )}

      {canManage && (
        <section className="mt-6 rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-medium text-slate-900">邀请成员</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            邮箱已注册 → 直接加入空间;邮箱未注册 → 填姓名与初始密码,系统会为他建号。
          </p>

          <form onSubmit={handleAdd} className="mt-4 grid gap-3 sm:grid-cols-2">
            <TextField
              label="企业邮箱"
              type="email"
              required
              value={email}
              onChange={(e) => void setEmail(e.target.value)}
              placeholder="someone@example.com"
            />
            <SelectField
              label="角色"
              value={newRole}
              onChange={(e) => void setNewRole(e.target.value as SpaceRole)}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} —— {option.hint}
                </option>
              ))}
            </SelectField>
            <TextField
              label="姓名(仅建号时必填)"
              value={name}
              onChange={(e) => void setName(e.target.value)}
              placeholder="留空表示该邮箱已注册"
            />
            <TextField
              label="初始密码(仅建号时必填)"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => void setPassword(e.target.value)}
              hint="至少 8 位"
            />

            <div className="sm:col-span-2">
              <Button type="submit" disabled={addMember.isPending || email.trim() === ''}>
                {addMember.isPending ? '处理中…' : '加入空间'}
              </Button>
            </div>

            <div className="sm:col-span-2">
              <ErrorNote error={addMember.error} />
            </div>
          </form>
        </section>
      )}

      <section className="mt-6">
        {members.isPending && <p className="text-sm text-slate-400">加载中…</p>}
        {members.isError && <ErrorNote error={members.error} />}

        {members.isSuccess && (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {members.data.members.map((member) => (
              <li key={member.userId} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={`flex h-8 w-8 flex-none items-center justify-center rounded-full text-sm ring-1 ${avatarClass(member.avatarColor)}`}
                >
                  {Array.from(member.name)[0] ?? '?'}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm text-slate-900">{member.name}</span>
                    {member.isOwner && (
                      <span className="flex-none rounded bg-slate-100 px-1.5 text-[10px] text-slate-600">
                        所有者
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    {member.email}
                    {member.department !== null && ` · ${member.department}`}
                  </span>
                </span>

                {canManage && !member.isOwner ? (
                  <span className="flex flex-none items-center gap-2">
                    <SelectField
                      value={member.role}
                      disabled={updateRole.isPending}
                      onChange={(e) => {
                        updateRole.mutate({
                          userId: member.userId,
                          role: e.target.value as SpaceRole,
                        });
                      }}
                    >
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </SelectField>

                    <Button
                      variant="danger"
                      disabled={removeMember.isPending}
                      onClick={() => {
                        removeMember.mutate(member.userId);
                      }}
                    >
                      移除
                    </Button>
                  </span>
                ) : (
                  <span className="flex-none rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                    {ROLE_LABELS[member.role]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="mt-3 space-y-2">
            <ErrorNote error={updateRole.error} />
            <ErrorNote error={removeMember.error} />
            <p className="text-xs text-slate-400">
              空间所有者不能被移除或降级;最后一个管理员也不能 ——
              否则这个空间会变成没人能管理的死结。
            </p>
          </div>
        )}

        {members.isSuccess && !canManage && (
          <p className="mt-3 text-xs text-slate-400">
            角色说明:管理员可管理成员与全部页面;编辑者可创建与修改页面;评论者只能留言;只读成员仅可浏览。
          </p>
        )}
      </section>
    </div>
  );
}
