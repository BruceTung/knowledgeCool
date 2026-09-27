/**
 * 批量移动「选择整理」的纯逻辑测试(v2.14)。
 *
 * 这里测的不是「能不能移」,而是**界面该不该让用户点下去、以及点错了怎么解释**。
 * 判断错了的后果:用户勾了 5 个,系统只动 2 个而他不知道为什么 ——
 * 或者反过来,让他点了一个必然被服务端拒掉的目标,然后在最后一步收到报错。
 */
import { describe, expect, it } from "vitest";

import type { OrgTreeNode } from "../features/org/tree-utils";
import { destinationCandidates, pathLabel, tidySelection } from "./bulk-move";

function node(id: string, parentId: string | null, title: string, kind: string = "space"): OrgTreeNode {
  return {
    id,
    parentId,
    kind: kind as OrgTreeNode["kind"],
    title,
    position: 0,
    depth: parentId === null ? 0 : 1,
    status: "published",
    version: 1,
    visibility: "public",
    ownerId: "u-1",
    ownerName: "某人",
    commentCount: 0,
    children: [],
  };
}

/** 技术部 ─ { 后端组 ─ { 接口规范 }, CRM 项目 };市场部 */
function tree(): OrgTreeNode[] {
  const api = node("doc-api", "grp-be", "接口规范", "document");
  const group: OrgTreeNode = { ...node("grp-be", "dept-tech", "后端组"), children: [api] };
  const crm = node("grp-crm", "dept-tech", "CRM 项目");
  const tech: OrgTreeNode = { ...node("dept-tech", null, "技术部"), children: [group, crm] };
  const mkt = node("dept-mkt", null, "市场部");
  return [tech, mkt];
}

describe("tidySelection —— 只保留最外层", () => {
  it("没有嵌套时原样保留", () => {
    const result = tidySelection(tree(), ["grp-be", "grp-crm"]);
    expect(result.kept).toEqual(["grp-be", "grp-crm"]);
    expect(result.dropped).toEqual([]);
  });

  it("★ 选了 A 又选它里面的 B → 只留 A,并说明 B 为什么被去掉", () => {
    // 静默缩小用户的选择是最糟的处理方式:他会以为系统自作主张。
    const result = tidySelection(tree(), ["grp-be", "doc-api"]);
    expect(result.kept).toEqual(["grp-be"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.title).toBe("接口规范");
    expect(result.dropped[0]?.reason).toContain("后端组");
  });

  it("深层嵌套也只留最外层(三层选满 → 留一个)", () => {
    const result = tidySelection(tree(), ["dept-tech", "grp-be", "doc-api"]);
    expect(result.kept).toEqual(["dept-tech"]);
    expect(result.dropped).toHaveLength(2);
  });

  it("顺序无关:先选里面的再选外面的,结果一样", () => {
    const result = tidySelection(tree(), ["doc-api", "grp-be"]);
    expect(result.kept).toEqual(["grp-be"]);
    expect(result.dropped).toHaveLength(1);
  });

  it("兄弟不会被误判成嵌套", () => {
    const result = tidySelection(tree(), ["grp-be", "grp-crm", "dept-mkt"]);
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toEqual([]);
  });
});

describe("destinationCandidates —— 目标下拉里该出现谁", () => {
  it("★ 排除选中项自己", () => {
    const ids = destinationCandidates(tree(), ["grp-be"]).map((item) => item.id);
    expect(ids).not.toContain("grp-be");
  });

  it("★★ 排除选中项的子孙 —— 选了它们会成环,服务端必然拒", () => {
    // 让用户能选中一个注定失败的目标,等于把错误推到最后一步才告诉他。
    const ids = destinationCandidates(tree(), ["grp-be"]).map((item) => item.id);
    expect(ids).not.toContain("doc-api");
  });

  it("★ 选中项的祖先仍然可以当目标(那是归位,拖拽就是这个语义)", () => {
    const ids = destinationCandidates(tree(), ["grp-be"]).map((item) => item.id);
    expect(ids).toContain("dept-tech");
  });

  it("文档不能当父节点(只列 space)", () => {
    const ids = destinationCandidates(tree(), []).map((item) => item.id);
    expect(ids).not.toContain("doc-api");
    expect(ids).toEqual(["dept-tech", "grp-be", "grp-crm", "dept-mkt"]);
  });

  it("没选任何东西时,所有 space 都可选", () => {
    expect(destinationCandidates(tree(), []).length).toBe(4);
  });
});

describe("pathLabel —— 下拉里的那一行", () => {
  it("拼出从根到自己的路径", () => {
    expect(pathLabel(tree(), "doc-api")).toBe("技术部 / 后端组 / 接口规范");
  });

  it("根节点就是它的标题", () => {
    expect(pathLabel(tree(), "dept-tech")).toBe("技术部");
  });

  it("查不到时返回空串(不留一个 undefined 在界面上)", () => {
    expect(pathLabel(tree(), "nope")).toBe("");
  });
});
