/**
 * 图片文件头的嗅探(纯函数,无 IO)。
 *
 * ## 为什么需要它
 *
 * 上传接口原来**只看扩展名**(isAllowedExtension)。扩展名是**用户说了算**的:
 * 把一个 HTML 文件改名成 evil.png 就能通过白名单,落盘、并可以被取回。
 *
 * 实测(真机):一段 HTML(含 script 标签)改名 .png →
 * POST /api/v1/uploads 返回 **201**,文件被存下,取回时内容原样是那段 HTML。
 *
 * ## 危害到底有多大(如实写,不夸大)
 *
 * Nginx 对这些文件发的是 Content-Type: image/png **且带
 * X-Content-Type-Options: nosniff**,所以**不会**在浏览器里当 HTML 执行 ——
 * 不是存储型 XSS。真正的问题是:
 *   - **任意类型的文件都能存进来**(只要改个后缀),上限 10MB/个、且**不清理孤儿**,
 *     等于给每个登录用户开了一个不限类型的文件寄存处;
 *   - 「这是图片」这个前提在**服务端从未被确认过**,后续任何依赖它的逻辑
 *     (缩略图、导出、格式转换)都会拿到意料之外的字节。
 *
 * ## 为什么按「扩展名 + 文件头必须**同时**匹配」来判
 *
 * 只看文件头不够:.jpg 里装着合法 PNG 头也是可以想象的组合,而
 * 文件名与内容不一致会让下游(以及人)困惑。所以规则是:
 *
 *   1. 扩展名在白名单里;
 *   2. 文件头能认出**某一种**被支持的图片格式;
 *   3. 两者**必须是同一种格式**。
 *
 * 第 3 条是有意从严的。放宽它(只要求「文件头是图片」)会允许
 * a.jpg 里放 GIF 数据 —— 多数查看器能显示,但一旦有人按后缀做处理就会出错。
 *
 * ## 只做「是不是图片」,不做「图片是否完好」
 *
 * 这里只比对**文件头那几个字节**。截断的、损坏的、以及把恶意数据塞在合法头之后的
 * 文件**都能通过** —— 那需要完整的解码器才能判,而解码器本身也是攻击面。
 * 这一步解决的是「任意类型文件寄存」,不是「图片内容安全」。
 */

/** 支持的图片格式。键与 ALLOWED_EXTENSIONS 里的后缀一一对应。 */
export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

/** 后缀 → 格式。.jpeg 与 .jpg 是同一种东西。 */
export const EXTENSION_TO_KIND: Readonly<Record<string, ImageKind>> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.avif': 'avif',
};

function startsWith(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** RIFF + 4 字节长度 + WEBP —— WebP 的签名被长度字段隔开,不能当成连续前缀。 */
function isWebp(buffer: Buffer): boolean {
  return (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

/** ISO-BMFF:第 4-8 字节是 ftyp,随后是 brand。avif / avis 都算。 */
function isAvif(buffer: Buffer): boolean {
  if (!startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) return false;
  return (
    startsWith(buffer, [0x61, 0x76, 0x69, 0x66], 8) ||
    startsWith(buffer, [0x61, 0x76, 0x69, 0x73], 8)
  );
}

/**
 * 从文件头认出格式。认不出返回 null。
 *
 * 顺序无所谓(签名互不重叠),但 PNG 放最前是因为它最常见。
 */
export function sniffImageKind(buffer: Buffer): ImageKind | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (isWebp(buffer)) return 'webp';
  if (isAvif(buffer)) return 'avif';
  return null;
}

/** 校验结果。ok 为 false 时 reason 是给用户看的一句话。 */
export type VerifyImageResult =
  { ok: true; kind: ImageKind; extension: string } | { ok: false; reason: string };

/**
 * 扩展名与文件头**必须同时**成立且指同一种格式。
 *
 * extension 传规范化后的后缀(带点、小写),例如 .png。
 */
export function verifyImage(extension: string, buffer: Buffer): VerifyImageResult {
  const expected = EXTENSION_TO_KIND[extension];
  if (expected === undefined) {
    const shown = extension === '' ? '(无后缀)' : extension;
    return { ok: false, reason: '不支持的文件类型 ' + shown };
  }

  const actual = sniffImageKind(buffer);
  if (actual === null) {
    return { ok: false, reason: '这个文件的内容不是图片(文件头认不出来)' };
  }
  if (actual !== expected) {
    return {
      ok: false,
      reason: '文件内容其实是 ' + actual + ',但后缀写的是 ' + extension + ' —— 两者必须一致',
    };
  }

  return { ok: true, kind: actual, extension };
}
