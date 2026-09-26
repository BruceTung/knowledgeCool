/**
 * 上传的类型白名单测试(M4)。
 *
 * 黑名单式的"禁止可执行文件"永远列不全,所以只做白名单。
 * 这里把边界情形钉死 —— 尤其是**双扩展名**(`shell.png.exe`)。
 */
import { describe, expect, it } from 'vitest';

import { ALLOWED_EXTENSIONS, isAllowedExtension, safeExtension } from './upload.controller.js';

describe('isAllowedExtension', () => {
  it('常见图片类型放行', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif']) {
      expect(isAllowedExtension(name)).toBe(true);
    }
  });

  it('大小写不敏感', () => {
    expect(isAllowedExtension('photo.PNG')).toBe(true);
    expect(isAllowedExtension('photo.JpEg')).toBe(true);
  });

  it('⚠️ 双扩展名只看最后一段:shell.png.exe 必须被拒', () => {
    expect(isAllowedExtension('shell.png.exe')).toBe(false);
  });

  it('SVG 被拒 —— 它能内嵌脚本,是存储型 XSS 载体', () => {
    expect(isAllowedExtension('logo.svg')).toBe(false);
  });

  it('可执行 / 脚本 / HTML 一律被拒', () => {
    for (const name of ['a.sh', 'a.bat', 'a.exe', 'a.js', 'a.html', 'a.php', 'a.zip']) {
      expect(isAllowedExtension(name)).toBe(false);
    }
  });

  it('没有扩展名 → 被拒', () => {
    expect(isAllowedExtension('README')).toBe(false);
    expect(isAllowedExtension('')).toBe(false);
  });
});

describe('safeExtension', () => {
  it('返回小写扩展名', () => {
    expect(safeExtension('A.PNG')).toBe('.png');
  });

  it('非白名单扩展名也原样返回,由 isAllowedExtension 负责拒绝', () => {
    // 两个函数职责分离:一个"取",一个"判",不混在一起
    expect(safeExtension('a.exe')).toBe('.exe');
    expect(isAllowedExtension('a.exe')).toBe(false);
  });

  it('白名单本身不允许通配或空串', () => {
    expect(ALLOWED_EXTENSIONS.every((ext) => ext.startsWith('.') && ext.length > 1)).toBe(true);
  });
});
