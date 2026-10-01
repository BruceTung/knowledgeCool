/**
 * 附件上传(M4:编辑器插入/粘贴图片)。
 *
 * 四个决定:
 *
 * 1. **白名单扩展名**,不是"禁止可执行文件"的黑名单 —— 白名单只有图片。
 * 2. **文件名由服务端生成**(UUID + 规范化扩展名),不采用用户传来的名字:
 *    原始文件名可能带路径分隔符(`../../etc/passwd`),也可能把 HTML 伪装成图片。
 * 3. **落盘目录与访问路径分离**:文件写到 `UPLOAD_DIR`,对外 URL 前缀是
 *    `/uploads/`,由 Nginx 直接提供 —— 图片是静态字节流,让 Nest 转发纯属浪费。
 * 4. **不放 SVG**:SVG 能内嵌 `<script>`,是典型的存储型 XSS 载体。
 *
 * ⚠️ 阶段一的取舍:**不压缩、不做缩略图、不清理孤儿文件**。
 * 孤儿文件(上传了但没插进文档)在阶段一不处理:数据量小,
 * 而清理需要引用计数,那是阶段二的事。这一点写进 DESIGN §11.3 了。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';

import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';

import { AppError } from '../common/errors/app-error.js';

/** 允许的图片类型。 */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
];

/** 单文件上限。与 Nginx 的 `client_max_body_size 20m` 配套,留出表单开销余量。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 上传接口的响应体。 */
export interface UploadResult {
  /** 对外可访问的 URL,直接给编辑器当 `src`。 */
  url: string;
  name: string;
  size: number;
}

/**
 * 落盘目录。
 *
 * 读 `process.env` 而不是注入 ConfigService:multer 的 storage 回调在
 * **类装饰器求值时就生成了**,那时 `this` 还不存在 —— 拿不到实例字段。
 * 与 `config/configuration.ts` 的 `uploadDir` 读的是同一个变量,不会漂移。
 */
function uploadDir(): string {
  return process.env['UPLOAD_DIR'] ?? './data/uploads';
}

/**
 * 规范化扩展名。
 *
 * 取不到或不在白名单里时,返回一个**一定不会被白名单命中**的值,
 * 而不是抛错 —— 让 multer 走 `cb(null, false)` 那条静默跳过的路径。
 * (若在这里抛错,`this` 上下文和错误映射都会变得难预测。)
 */
export function safeExtension(originalName: string): string {
  return extname(originalName).toLowerCase();
}

export function isAllowedExtension(originalName: string): boolean {
  return ALLOWED_EXTENSIONS.includes(safeExtension(originalName));
}

@Controller('uploads')
export class UploadController {
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = uploadDir();
          // 启动时已经建过一次,这里再兜一次:目录被运维清掉过也不算故障
          try {
            mkdirSync(dir, { recursive: true });
          } catch {
            // 建不出来就让 multer 自己去报错,信息比这里编的更准确
          }
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          // 服务端生成文件名:不信任用户传来的名字(可能含路径分隔符)
          cb(
            null,
            `${randomUUID()}${isAllowedExtension(file.originalname) ? safeExtension(file.originalname) : ''}`,
          );
        },
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        // `cb(null, false)` 让 multer **静默跳过**这个文件,
        // 于是处理器里看到 `file === undefined`,能返回干净的 400 而不是 500。
        cb(null, isAllowedExtension(file.originalname));
      },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File | undefined): UploadResult {
    if (file === undefined) {
      throw AppError.validation(
        `只支持图片(${ALLOWED_EXTENSIONS.join(' / ')}),且不超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
      );
    }

    return {
      url: `/uploads/${file.filename}`,
      name: file.originalname,
      size: file.size,
    };
  }
}
