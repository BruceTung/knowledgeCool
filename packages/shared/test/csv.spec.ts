/**
 * CSV 生成的纯函数测试(v2.14)。
 *
 * 两类问题各自都**不会报错**:
 *   - 转义漏了 → Excel 里列错位(没人会想到是导出写错了);
 *   - 公式注入没防 → 打开导出文件的人**执行了别人写的公式**(安全问题)。
 *
 * 期望值一律用 D / Q 两个字符常量拼,不手写引号串 —— 我第一版就是手写的,
 * 把「包双引号」写成了「前面加单引号」,五条用例全红而实现其实是对的。
 * 引号挤在一起时,人是看不出来的。
 *
 * 本文件**只用双引号字符串**(便于生成),内容里的引号一律靠 D / Q 拼。
 */
import { describe, expect, it } from "vitest";

import { csvCell, toCsv } from "../src/csv.js";

const D = String.fromCharCode(34);
const Q = String.fromCharCode(39);
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const BOM = String.fromCharCode(0xfeff);

/** 用双引号包起来(RFC 4180 的转义形式)。 */
function wrap(s: string): string {
  return D + s + D;
}
/** 前缀单引号(公式注入防护)。 */
function guard(s: string): string {
  return Q + s;
}

describe("csvCell —— 转义", () => {
  it("普通文本原样返回", () => {
    expect(csvCell("技术部")).toBe("技术部");
    expect(csvCell(42)).toBe("42");
  });

  it("含逗号的字段要包双引号,否则列会错位", () => {
    expect(csvCell("技术部,后端组")).toBe(wrap("技术部,后端组"));
  });

  it("含引号的字段:包双引号,且内部引号翻倍(RFC 4180)", () => {
    const inner = "他说" + D + "你好" + D;
    expect(csvCell(inner)).toBe(wrap("他说" + D + D + "你好" + D + D));
  });

  it("含换行时要包双引号(否则一行会被拆成两行)", () => {
    const inner = "a" + LF + "b";
    expect(csvCell(inner)).toBe(wrap(inner));
  });

  it("null / undefined 渲染成空单元格,而不是字面量 null", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("首尾空白也包双引号 —— 否则部分工具会把它吃掉", () => {
    expect(csvCell(" 接口 ")).toBe(wrap(" 接口 "));
  });
});

describe("csvCell —— 公式注入防护(安全)", () => {
  it("★ 以等号开头的字段被前缀单引号,不再当公式", () => {
    expect(csvCell("=1+1")).toBe(guard("=1+1"));
  });

  it("★ 加号 / 减号 / at 开头同样处理", () => {
    expect(csvCell("+1")).toBe(guard("+1"));
    expect(csvCell("-1")).toBe(guard("-1"));
    expect(csvCell("@SUM(A1)")).toBe(guard("@SUM(A1)"));
  });

  it("★ 前缀单引号之后再走转义 —— 顺序反了会前功尽弃", () => {
    // 先转义再防护的话,单引号会落在双引号**外面**,Excel 仍然会执行公式。
    expect(csvCell("=1,2")).toBe(wrap(guard("=1,2")));
  });

  it("普通字段不受影响(不误伤正常内容)", () => {
    expect(csvCell("后端组-接口规范")).toBe("后端组-接口规范");
  });
});

describe("toCsv", () => {
  it("★ 带 BOM —— 不加的话 Excel 打开是乱码,而这份导出的用途正是发给别人", () => {
    expect(toCsv(["a"], [["b"]]).startsWith(BOM)).toBe(true);
  });

  it("用 CRLF 换行(RFC 4180,Windows 工具更稳)", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe(BOM + "a,b" + CRLF + "1,2" + CRLF);
  });

  it("表头也走同一套转义(别假设表头一定干净)", () => {
    expect(toCsv(["含,逗号"], [])).toBe(BOM + wrap("含,逗号") + CRLF);
  });

  it("没有数据行时只有表头", () => {
    expect(toCsv(["a"], [])).toBe(BOM + "a" + CRLF);
  });

  it("每行字段数与表头一致(不因为转义而多出列)", () => {
    const csv = toCsv(["a", "b"], [["1,2", "3"], [null, "x"]]);
    const lines = csv.slice(1).trimEnd().split(CRLF);
    expect(lines).toHaveLength(3);
  });
});
