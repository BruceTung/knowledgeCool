/**
 * 复制到剪贴板 —— **带降级路径**(v2.12)。
 *
 * ⚠️ `navigator.clipboard` 只在**安全上下文**(https 或 localhost)里存在。
 * 本系统是内网自托管,很可能就是 `http://10.x.x.x` —— 那种部署下
 * `navigator.clipboard` 直接是 undefined。只用它的话,"复制链接"会在
 * **最需要它的那种部署形态上**完全失灵,而且是在用户点下去那一刻才暴露。
 *
 * 降级走 `document.execCommand('copy')`:是个老 API,但不需要安全上下文。
 *
 * 返回是否成功。调用方**必须**把失败说出来 —— "复制了但没成功"比
 * "没得复制"更糟,用户会去粘贴一段旧内容。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒、非安全上下文等 —— 一律往下走降级路径
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    // readOnly 防止移动端弹出软键盘;定位到视口外但**必须留在文档里**,
    // 否则 execCommand('copy') 取不到选区。
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
