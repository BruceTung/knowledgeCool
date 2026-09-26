/**
 * 正文与附件相关的服务端状态。
 *
 * 正文本身的读取/保存/导出在 `features/org/queries.ts`(它们与节点是同一族)——
 * 这里只留图片上传,因为它是纯粹的附件能力,与节点无关。
 */
import { useMutation } from '@tanstack/react-query';

import { apiUpload } from '../../lib/api';

/**
 * 上传图片,返回可直接当 `src` 用的 URL。
 *
 * 返回值里的 `url` 是服务端生成的 `/uploads/<uuid>.<ext>` —— 不使用原始文件名,
 * 因为那可能带路径分隔符或伪装成图片的 HTML。
 */
export function useImageUpload() {
  return useMutation({
    mutationFn: (file: File) => apiUpload<{ url: string }>('/uploads', file),
  });
}
