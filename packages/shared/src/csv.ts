/**
 * CSV 生成(v2.14)—— 给审计导出用。
 *
 * ⚠️ 这不是"拼字符串"那么简单,有两类问题必须处理,而它们**都不会报错**:
 *
 * ## 一、转义
 * 字段里含逗号、引号或换行时要包引号,并且把内部引号翻倍。
 * 漏了的表现是**列错位** —— Excel 里看起来"数据整体往右移了一位",
 * 而没人会想到是导出写错了。
 *
 * ## 二、公式注入(★ 安全)
 * Excel / WPS / Numbers 会把以 `=`、`+`、`-`、`@` 开头的单元格**当公式执行**。
 * 而审计导出里的"目标标题"是**用户可控的**(谁都可以把文档命名成 `=1+1`),
 * 更极端的形式(`=cmd|'/c calc'!A1` 这类 DDE)在旧版 Excel 上能拉起外部程序。
 * 所以:**任何以这四个字符开头的字段,前面加一个单引号**,让它变成文本。
 * 单引号在 Excel 里不显示,只表示"这一格是文本",不影响可读性。
 *
 * 这条容易被当成过度设计 —— 直到有人真的把文档命名成 `=HYPERLINK(...)`。
 * 导出文件是**发出去**的,只在服务端假设"用户不会那么坏"是不成立的。
 */

/** 会把单元格变成公式的起始字符。 */
const FORMULA_START = ['=', '+', '-', '@'];

/**
 * 把一个字段渲染成合法的 CSV 单元格。
 *
 * 顺序很重要:先做公式防护,再做引号转义 —— 反过来的话,
 * 加上的那个单引号会落在引号外面,转义就白做了。
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);

  // 公式注入防护
  const guarded = FORMULA_START.some((char) => text.startsWith(char)) ? "'" + text : text;

  // 需要包引号的情况:含分隔符、引号、换行、或首尾空白
  if (/[",\n\r]/.test(guarded) || guarded !== guarded.trim()) {
    return '"' + guarded.replaceAll('"', '""') + '"';
  }
  return guarded;
}

/**
 * 生成 CSV 文本。
 *
 * ⚠️ 加 **BOM**(`\uFEFF`)。不加的话 Excel 会按本地代码页解码,
 * 中文变成乱码 —— 而这份导出的主要用途恰恰是"发给别人用 Excel 打开",
 * 乱码等于整个功能没用。BOM 是让 Excel 认出 UTF-8 的唯一可靠办法。
 *
 * @param header 表头(也走同一套转义 —— 别假设表头一定干净)
 * @param rows   数据行
 */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  // CRLF:Excel 与 RFC 4180 都认这个,而裸 LF 在部分 Windows 工具里会被拼成一行
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
