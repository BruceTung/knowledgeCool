import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, ErrorNote, SelectField, TextField } from '../components/ui';
import { T_BADGE, T_BODY } from '../lib/typography';
import { useCreateOrgNode, useOrgScopes, useOrgUsers } from '../features/admin/queries';
import { OrgImportPanel } from '../features/admin/OrgImportPanel';
import { useOrgTree } from '../features/org/queries';
import { buildTree } from '../features/org/tree-utils';

/**
 * 组织架构管理(超管)。
 *
 * 两件事:**建组织**(部门 / 组)与**导名单**(Excel,§8.5)。
 *
 * ⚠️ 这里刻意**不做"删除部门"**。删掉一个部门会连带影响它下面所有内容与
 * 人的归属,而阶段一没有"部门归档"这个概念。要停用一个部门,
 * 正确做法是先把里面的人和内容挪走 —— 那是下一轮的事(§11.3)。
 */
export function OrgAdminPage() {
  const scopes = useOrgScopes();
  const users = useOrgUsers('');
  const tree = useOrgTree();
  const createNode = useCreateOrgNode();

  const [deptName, setDeptName] = useState('');
  const [deptOwner, setDeptOwner] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupParent, setGroupParent] = useState('');
  const [groupOwner, setGroupOwner] = useState('');

  const activeUsers = (users.data ?? []).filter((user) => user.status === 'active');

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-8 py-8">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">组织架构</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          一级是<b>部门</b>(所有者 = 部长),二级是<b>组 / 项目</b>(所有者由部长任命)。
          再往下是使用者自己建的内容,不在这里维护。
        </p>
      </div>

      {/* ---------------- 建部门 ---------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-900">新建部门</h2>
        <p className="mt-1 text-xs text-slate-500">
          部门必须有一个负责人(部长),否则这个部门没人能管。负责人必须是<b>在职</b>账号。
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1">
            <TextField
              label="部门名称"
              value={deptName}
              onChange={(event) => {
                setDeptName(event.target.value);
              }}
              placeholder="例如 技术部"
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <SelectField
              label="负责人"
              value={deptOwner}
              onChange={(event) => {
                setDeptOwner(event.target.value);
              }}
            >
              <option value="">选择部长…</option>
              {activeUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}（{user.employeeNo}）
                </option>
              ))}
            </SelectField>
          </div>
          <Button
            className="flex-none"
            disabled={deptName.trim() === '' || deptOwner === '' || createNode.isPending}
            onClick={() => {
              createNode.mutate(
                { name: deptName.trim(), parentId: null, ownerId: deptOwner },
                {
                  onSuccess: () => {
                    setDeptName('');
                    setDeptOwner('');
                  },
                },
              );
            }}
          >
            新建部门
          </Button>
        </div>
        <ErrorNote error={createNode.error} />
      </section>

      {/* ---------------- 建组 ---------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-900">新建组 / 项目</h2>
        <p className="mt-1 text-xs text-slate-500">
          组必须挂在某个部门下面。不指定负责人时,由部门负责人代管
          —— 他本来就能改本部门的全部内容。
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <SelectField
              label="所属部门"
              value={groupParent}
              onChange={(event) => {
                setGroupParent(event.target.value);
              }}
            >
              <option value="">选择部门…</option>
              {(scopes.data ?? [])
                .filter((scope) => !scope.path.includes(' / '))
                .map((scope) => (
                  <option key={scope.nodeId} value={scope.nodeId}>
                    {scope.path}（{scope.memberCount} 人）
                  </option>
                ))}
            </SelectField>
          </div>
          <div className="min-w-[160px] flex-1">
            <TextField
              label="组 / 项目名称"
              value={groupName}
              onChange={(event) => {
                setGroupName(event.target.value);
              }}
              placeholder="例如 后端组"
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <SelectField
              label="负责人(可空)"
              value={groupOwner}
              onChange={(event) => {
                setGroupOwner(event.target.value);
              }}
            >
              <option value="">暂不指定</option>
              {activeUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}（{user.employeeNo}）
                </option>
              ))}
            </SelectField>
          </div>
          <Button
            className="flex-none"
            disabled={groupName.trim() === '' || groupParent === '' || createNode.isPending}
            onClick={() => {
              createNode.mutate(
                {
                  name: groupName.trim(),
                  parentId: groupParent,
                  ...(groupOwner === '' ? {} : { ownerId: groupOwner }),
                },
                {
                  onSuccess: () => {
                    setGroupName('');
                    setGroupOwner('');
                  },
                },
              );
            }}
          >
            新建
          </Button>
        </div>
        <ErrorNote error={createNode.error} />
      </section>

      {/* ---------------- 现有结构 ---------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-900">现有结构</h2>
        {tree.isPending && <p className="mt-2 text-xs text-slate-400">加载中…</p>}
        {tree.data !== undefined && (
          <ul className="mt-2 space-y-1">
            {buildTree(tree.data.nodes).map((department) => (
              <li key={department.id}>
                <div className="flex items-center gap-2 text-sm">
                  <Link to={`/n/${department.id}`} className="text-slate-900 hover:underline">
                    {department.title}
                  </Link>
                  <span className="text-[11px] text-slate-400">
                    部长 {department.ownerName} · {department.children.length} 个子节点
                  </span>
                </div>
                {department.children.length > 0 && (
                  <ul className="ml-4 mt-0.5 space-y-0.5">
                    {department.children.map((child) => (
                      <li key={child.id} className={`flex items-center gap-2 ${T_BODY}`}>
                        {/* ⚠️ 必须按 kind 区分:空间与页面在同一棵树上(§4.1),
                            把文档也标成「组长」会让人以为它是个组 */}
                        <span
                          className={`flex-none rounded px-1 ${T_BADGE} ${
                            child.kind === 'space'
                              ? 'bg-teal-50 text-teal-700'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {child.kind === 'space' ? '组' : '页'}
                        </span>
                        <Link to={`/n/${child.id}`} className="text-slate-600 hover:underline">
                          {child.title}
                        </Link>
                        <span className="text-[11px] text-slate-400">
                          {child.kind === 'space' ? '组长' : '所有者'} {child.ownerName}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {tree.data?.nodes.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">
            还没有任何部门。可以手工建,也可以用下面的 Excel 一次导入。
          </p>
        )}
      </section>

      {/* ---------------- Excel 导入 ---------------- */}
      <OrgImportPanel />
    </div>
  );
}
