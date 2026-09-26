/**
 * 页面评论面板(DESIGN.md §8.4)。
 *
 * 阶段一的评论**不锚定到文字** —— 只有"挂在这一页上"这一层。
 * 所以界面上也没有"选中一段再评论"的入口,这不是漏做,是范围。
 */
import { COMMENT_BODY_MAX_LENGTH, type CommentView } from '@knowledgecool/shared';
import { useState } from 'react';

import { avatarClass, Button, ErrorNote } from '../../components/ui';
import { T_BODY, T_META } from '../../lib/typography';
import { useCreateComment, useDeleteComment, useComments, useUpdateComment } from './queries';

export function CommentsPanel({ nodeId }: { nodeId: string }) {
  const comments = useComments(nodeId);
  const create = useCreateComment(nodeId);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  if (comments.isPending) return <p className="p-4 text-sm text-slate-400">加载评论…</p>;
  if (comments.isError) {
    return (
      <div className="p-4">
        <ErrorNote error={comments.error} />
      </div>
    );
  }

  const data = comments.data;

  function submit() {
    const body = draft.trim();
    if (body === '') return;
    create.mutate(
      { body, parentId: replyTo },
      {
        onSuccess: () => {
          setDraft('');
          setReplyTo(null);
        },
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {data.threads.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm leading-relaxed text-slate-400">
            还没有评论。评论区用来讨论这一页的内容。
          </p>
        ) : (
          <ul className="space-y-4">
            {data.threads.map((thread) => (
              <li key={thread.id} className="space-y-2">
                <CommentCard
                  comment={thread}
                  nodeId={nodeId}
                  onReply={() => {
                    setReplyTo(thread.id);
                  }}
                />
                {thread.replies.length > 0 && (
                  <ul className="ml-7 space-y-2 border-l border-slate-200 pl-3">
                    {thread.replies.map((reply) => (
                      <li key={reply.id}>
                        <CommentCard comment={reply} nodeId={nodeId} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-none border-t border-slate-200 p-3">
          {replyTo !== null && (
            <div className="mb-2 flex items-center justify-between text-sm text-slate-500">
              <span>正在回复这条评论</span>
              <button type="button" className="hover:text-slate-700" onClick={() => setReplyTo(null)}>
                取消
              </button>
            </div>
          )}
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value.slice(0, COMMENT_BODY_MAX_LENGTH));
            }}
            onKeyDown={(event) => {
              // Enter 发送、Shift+Enter 换行 —— 评论区约定俗成的行为
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder="写下你的评论…(Enter 发送,Shift+Enter 换行)"
            className={`w-full resize-none rounded-md border border-slate-300 px-2 py-1.5 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${T_BODY}`}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className={`text-slate-400 ${T_META}`}>
              {draft.length}/{COMMENT_BODY_MAX_LENGTH}
            </span>
            <Button disabled={create.isPending || draft.trim() === ''} onClick={submit}>
              {create.isPending ? '发送中…' : '发表'}
            </Button>
          </div>
          {create.isError && (
            <div className="mt-2">
              <ErrorNote error={create.error} />
            </div>
          )}
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  nodeId,
  onReply,
}: {
  comment: CommentView;
  nodeId: string;
  onReply?: () => void;
}) {
  const update = useUpdateComment(nodeId);
  const remove = useDeleteComment(nodeId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-medium ring-1 ${avatarClass(comment.author.avatarColor)}`}
        >
          {Array.from(comment.author.name)[0] ?? '?'}
        </span>
        {/*
          作者名与时间是**评论区里要被读的信息**,走 14px 内容档。
          上一轮把它们放在 12px,而正文也是 12px —— 于是整块看起来"一片小字"。
        */}
        <span className="text-sm font-medium text-slate-800">{comment.author.name}</span>
        {comment.author.departed && (
          <span
            className={`rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 ring-1 ring-amber-200 ${T_META}`}
          >
            已离职
          </span>
        )}
        <span className={`ml-auto text-slate-400 ${T_META}`}>
          {new Date(comment.createdAt).toLocaleString('zh-CN')}
        </span>
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value.slice(0, COMMENT_BODY_MAX_LENGTH));
            }}
            rows={3}
            className={`w-full resize-none rounded-md border border-slate-300 px-2 py-1.5 outline-none focus:border-blue-500 ${T_BODY}`}
          />
          <div className="mt-1 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
              }}
            >
              取消
            </Button>
            <Button
              disabled={update.isPending}
              onClick={() => {
                update.mutate(
                  { commentId: comment.id, body: draft },
                  { onSuccess: () => setEditing(false) },
                );
              }}
            >
              保存
            </Button>
          </div>
        </div>
      ) : (
        <p className={`mt-2 whitespace-pre-wrap leading-6 text-slate-700 ${T_BODY}`}>
          {comment.body}
        </p>
      )}

      {/* 操作是**要被点的**,走 14px;不再和"计数"那种细字印刷混在一档。 */}
      <div className="mt-2.5 flex items-center gap-4 text-sm text-slate-500">
        {onReply !== undefined && (
          <button type="button" className="hover:text-slate-600" onClick={onReply}>
            回复
          </button>
        )}
        {/* ⚠️ 「编辑」只认作者本人;「删除」还多一类:该节点的所有者(版务清理)。
            两者刻意分开 —— 所有者能删别人的评论,但不能改别人说的话。 */}
        {comment.canEdit && (
          <button type="button" className="hover:text-slate-600" onClick={() => setEditing(true)}>
            编辑
          </button>
        )}
        {comment.canDelete && (
          <button
            type="button"
            className="hover:text-red-600"
            onClick={() => {
              if (window.confirm('删除这条评论?回复会一并删除。')) {
                remove.mutate(comment.id);
              }
            }}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

