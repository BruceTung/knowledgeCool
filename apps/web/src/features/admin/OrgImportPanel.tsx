/**
 * 组织架构导入向导(DESIGN.md §8.5)。
 *
 * 三步两阶段:**下载模板 → 上传得到差异预览(dryRun,不写库)→ 确认写入**。
 *
 * 两阶段不是花架子,它挡的是"上传即覆盖"这类事故 —— 而这次选的是**增量**语义
 * (只加不删),所以预览要展示的是"会新增什么、会不会改到别的东西",
 * 而不是"哪些会被删掉"。
 *
 * ⚠️ 确认写入时会**重新上传同一份文件**,并带上预览返回的 `contentHash`。
 * 服务端比对不一致就拒绝 —— 防的是"预览之后又改了一版表格再上传,
 * 写入的却是他没看过的那一份"。
 */
import type { OrgImportPreview, OrgImportResult, OrgImportResponse } from '@knowledgecool/shared';
import { useRef, useState, type ReactNode } from 'react';

import { Button, ErrorNote } from '../../components/ui';
import { useImportOrg, useImportTemplate } from './queries';

function CountRow({ label, count, children }: { label: string; count: number; children?: ReactNode }) {
  return (
    <div className="border-t border-slate-100 py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="flex-none rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
          {label}
        </span>
        <span className={`text-sm font-medium ${count === 0 ? 'text-slate-300' : 'text-slate-900'}`}>
          {count}
        </span>
      </div>
      {count > 0 && children !== undefined && (
        <div className="mt-1 max-h-40 overflow-auto pl-1 text-[11px] leading-relaxed text-slate-500">
          {children}
        </div>
      )}
    </div>
  );
}

function PreviewBody({ preview }: { preview: OrgImportPreview }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-1">
      <CountRow label="新建人员" count={preview.newUsers.length}>
        {preview.newUsers.map((user) => (
          <div key={user.employeeNo}>
            {user.name}（{user.employeeNo}）
            {user.nodePaths.length > 0 && ` → ${user.nodePaths.join('、')}`}
          </div>
        ))}
      </CountRow>

      <CountRow label="新建节点" count={preview.newNodes.length}>
        {preview.newNodes.map((node) => (
          <div key={node.path}>{node.path}</div>
        ))}
      </CountRow>

      <CountRow label="新增归属" count={preview.newAssignments.length}>
        {preview.newAssignments.map((item, index) => (
          <div key={`${item.employeeNo}-${String(index)}`}>
            {item.employeeNo} → {item.nodePath}
          </div>
        ))}
      </CountRow>

      <CountRow label="改名" count={preview.renamedUsers.length + preview.renamedNodes.length}>
        {preview.renamedUsers.map((item) => (
          <div key={`u-${item.employeeNo}`}>
            人员 {item.employeeNo}：{item.from} → {item.to}
          </div>
        ))}
        {preview.renamedNodes.map((item, index) => (
          <div key={`n-${String(index)}`}>
            节点 {item.nodePath}：{item.from} → {item.to}
          </div>
        ))}
      </CountRow>

      <CountRow label="换所有者" count={preview.ownerChanges.length}>
        {preview.ownerChanges.map((item) => (
          <div key={item.nodePath}>
            {item.nodePath}：{item.fromName ?? '（无）'} → {item.toName}
          </div>
        ))}
      </CountRow>

      {preview.ignoredRows.length > 0 && (
        <CountRow label="跳过" count={preview.ignoredRows.length}>
          {preview.ignoredRows.map((item) => (
            <div key={`${String(item.row)}-${item.reason}`}>
              第 {item.row} 行:{item.reason}
            </div>
          ))}
        </CountRow>
      )}
    </div>
  );
}

function ResultBody({ result }: { result: OrgImportResult }) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
      导入完成:新建人员 {result.createdUsers} 人、新建节点 {result.createdNodes} 个、新增归属{' '}
      {result.createdAssignments} 条、改名 {result.updatedNames} 处、换所有者 {result.updatedOwners}{' '}
      处。
      <p className="mt-1 text-[11px] text-emerald-800">
        新账号的初始密码是 <code className="rounded bg-white px-1">123456</code>,首次登录会被要求改成
        「8 位以上且同时含字母与数字」的新密码。
      </p>
    </div>
  );
}

export function OrgImportPanel() {
  const template = useImportTemplate();
  const importOrg = useImportOrg();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OrgImportResponse | null>(null);
  const [applied, setApplied] = useState<OrgImportResult | null>(null);

  const errorCount = preview?.preview.errors.length ?? 0;
  const hasBlockingErrors = errorCount > 0;

  function reset(): void {
    setFile(null);
    setPreview(null);
    setApplied(null);
    if (fileRef.current !== null) fileRef.current.value = '';
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-medium text-slate-900">用 Excel 维护全员名单</h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          模板里带着当前的组织架构与人员,你只需要在末尾<b>追加行</b>。
          一行 = 一个人在一个节点上的归属;同一个人写多行表示他同属多个部门 / 组 / 项目。
        </p>
        <ol className="mt-2 list-inside list-decimal space-y-0.5 text-xs leading-relaxed text-slate-500">
          <li>下载模板(含当前全部数据)</li>
          <li>填好之后上传 —— <b>不会立即写入</b>,先给你看差异</li>
          <li>确认差异无误,再点「确认导入」</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            disabled={template.isPending}
            onClick={() => {
              template.mutate();
            }}
          >
            {template.isPending ? '生成中…' : '① 下载模板'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="text-xs text-slate-600"
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null;
              setFile(picked);
              setPreview(null);
              setApplied(null);
            }}
          />
          <Button
            disabled={file === null || importOrg.isPending}
            onClick={() => {
              if (file === null) return;
              importOrg.mutate(
                { file, dryRun: true },
                { onSuccess: (result) => { setPreview(result); setApplied(null); } },
              );
            }}
          >
            {importOrg.isPending && applied === null ? '解析中…' : '② 上传并预览差异'}
          </Button>
        </div>
        <ErrorNote error={template.error ?? importOrg.error} />
      </div>

      {preview !== null && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-sm font-medium text-slate-900">差异预览</h3>
            <Button variant="secondary" className="flex-none" onClick={reset}>
              重新开始
            </Button>
          </div>

          {hasBlockingErrors ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
              <div className="text-xs font-medium text-red-800">
                表格里有 {errorCount} 个问题,<b>不能导入</b>。请修正后重新上传。
              </div>
              <div className="mt-1 max-h-48 overflow-auto text-[11px] leading-relaxed text-red-700">
                {preview.preview.errors.map((item, index) => (
                  <div key={`${String(item.row)}-${String(index)}`}>
                    {item.row === 0 ? '整体校验' : `第 ${item.row} 行`}:{item.reason}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              下面这些是<b>将要发生的变化</b>。没有出现在列表里的东西一律不动 ——
              包括表格里没写的人与节点(增量语义)。
            </p>
          )}

          <PreviewBody preview={preview.preview} />

          {applied === null ? (
            <div className="flex items-center gap-2">
              <Button
                disabled={hasBlockingErrors || importOrg.isPending || file === null}
                onClick={() => {
                  if (file === null) return;
                  importOrg.mutate(
                    { file, dryRun: false, contentHash: preview.contentHash },
                    { onSuccess: (result) => { setApplied(result.applied); setPreview(result); } },
                  );
                }}
              >
                {importOrg.isPending ? '写入中…' : '③ 确认导入'}
              </Button>
              {hasBlockingErrors && (
                <span className="text-[11px] text-red-600">有问题时不能导入</span>
              )}
            </div>
          ) : (
            applied !== null && <ResultBody result={applied} />
          )}
        </div>
      )}

      {applied !== null && preview === null && <ResultBody result={applied} />}
    </section>
  );
}
