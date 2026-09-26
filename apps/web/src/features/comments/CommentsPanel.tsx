/**
 * 页面评论面板(DESIGN.md §8.4)。
 *
 * 阶段一的评论**不锚定到文字** —— 只有"挂在这一页上"这一层。
 * 所以界面上也没有"选中一段再评论"的入口,这不是漏做,是范围。
 */
import { COMMENT_BODY_MAX_LENGTH, can, type CommentView, type SpaceRole } from '@knowledgecool/shared';
import { useState } from 'react';

import { avatarClass, Button, ErrorNote } from '../../components/ui';
import { useCreateComment, useDeleteComment, useComments, useUpdateComment } from './queries';

export function CommentsPanel({
  pageId,
  spaceId,
  role,
}: {
  pageId: string;
  spaceId: string;
  role: SpaceRole;
}) {
  const comments = useComments(pageId);
  const create = useCreateComment(spaceId, pageId);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  const canComment = can(role, 'comment.create');

  if (comments.isPending) return <p className="p-4 text-xs text-slate-400">加载评论…</p>;
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
          <p className="py-6 text-center text-xs text-slate-400">
            还没有评论。评论区用于讨论这一页的内容 —— 阶段一不做行内锚定。
          </p>
        ) : (
          <ul className="space-y-4">
            {data.threads.map((thread) => (
              <li key={thread.id} className="space-y-2">
                <CommentCard
                  comment={thread}
                  pageId={pageId}
                  spaceId={spaceId}
                  onReply={() => {
                    setReplyTo(thread.id);
                  }}
                />
                {thread.replies.length > 0 && (
                  <ul className="ml-7 space-y-2 border-l border-slate-200 pl-3">
                    {thread.replies.map((reply) => (
                      <li key={reply.id}>
                        <CommentCard comment={reply} pageId={pageId} spaceId={spaceId} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canComment ? (
        <div className="flex-none border-t border-slate-200 p-3">
          {replyTo !== null && (
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
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
            className="w-full resize-none rounded-md border border-slate-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">
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
      ) : (
        <p className="flex-none border-t border-slate-200 px-3 py-3 text-xs text-slate-400">
          你的角色是「{roleLabel(role)}」,可以查看评论但没有留言权限。
        </p>
      )}
    </div>
  );
}

function CommentCard({
  comment,
  pageId,
  spaceId,
  onReply,
}: {
  comment: CommentView;
  pageId: string;
  spaceId: string;
  onReply?: () => void;
}) {
  const update = useUpdateComment(spaceId, pageId);
  const remove = useDeleteComment(spaceId, pageId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  return (
    <div className="rounded-md border border-slate-200 bg-white p-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] ring-1 ${avatarClass(comment.author.avatarColor)}`}
        >
          {Array.from(comment.author.name)[0] ?? '?'}
        </span>
        <span className="text-xs font-medium text-slate-700">{comment.author.name}</span>
        <span className="text-[11px] text-slate-400">
          {new Date(comment.createdAt).toLocaleString('zh-CN')}
        </span>
        {comment.status === 'resolved' && (
          <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700 ring-1 ring-emerald-200">
            已解决
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value.slice(0, COMMENT_BODY_MAX_LENGTH));
            }}
            rows={3}
            className="w-full resize-none rounded-md border border-slate-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
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
        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
          {comment.body}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-400">
        {onReply !== undefined && (
          <button type="button" className="hover:text-slate-600" onClick={onReply}>
            回复
          </button>
        )}
        {comment.canResolve && (
          <button
            type="button"
            className="hover:text-slate-600"
            onClick={() => {
              update.mutate({
                commentId: comment.id,
                status: comment.status === 'resolved' ? 'open' : 'resolved',
              });
            }}
          >
            {comment.status === 'resolved' ? '重新打开' : '标记已解决'}
          </button>
        )}
        {comment.canDelete && (
          <>
            <button type="button" className="hover:text-slate-600" onClick={() => setEditing(true)}>
              编辑
            </button>
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
          </>
        )}
      </div>
    </div>
  );
}

function roleLabel(role: SpaceRole): string {
  const labels: Record<SpaceRole, string> = {
    admin: '空间管理员',
    editor: '编辑者',
    commenter: '评论者',
    viewer: '只读成员',
  };
  return labels[role];
}
