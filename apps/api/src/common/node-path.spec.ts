/**
 * 物化路径工具的纯函数测试(v2.14)。
 *
 * ## 为什么这一组值得单独写
 *
 * 这八个函数是**整个权限模型的地基**:判定的祖先链、移动时防环、面包屑、
 * 权限缓存的世代号分片,全都经过它们。
 *
 * 而它们错了**不会报错**,只会静默地多给或少给权限:
 *   · 前缀少了末尾那个斜杠 → /p-1 被当成 /p-10 的祖先,
 *     于是「一号部门的管理员能管到十号部门」,而界面上毫无异常;
 *   · prefixPathsOf 少返回一层 → 祖先链短一截,上级的所有者失去权限;
 *   · rootIdOfPath 取错 → 权限缓存的世代号分片错了,
 *     组织变更之后**别人的旧权限一直生效到 TTL 到期**。
 *
 * 这些都不是「报错」能暴露的。
 */
import { describe, expect, it } from 'vitest';

import {
  depthOfPath,
  idsOfPath,
  pathOfChild,
  pathOfRoot,
  prefixPathsOf,
  renderPath,
  rootIdOfPath,
  subtreePrefix,
} from './node-path.js';

describe('pathOfRoot / pathOfChild —— 构造', () => {
  it('根路径是 /<id>', () => {
    expect(pathOfRoot('dept')).toBe('/dept');
  });

  it('子路径接在父路径后面', () => {
    expect(pathOfChild('/dept', 'grp')).toBe('/dept/grp');
    expect(pathOfChild('/dept/grp', 'doc')).toBe('/dept/grp/doc');
  });

  it('构造与解析能往返', () => {
    const path = pathOfChild(pathOfChild(pathOfRoot('a'), 'b'), 'c');
    expect(idsOfPath(path)).toEqual(['a', 'b', 'c']);
  });
});

describe('idsOfPath —— 解析', () => {
  it('从根到自身,顺序不能反', () => {
    expect(idsOfPath('/a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('单层路径只有一个 id(根是 0 层,不是 1 层)', () => {
    expect(idsOfPath('/a')).toEqual(['a']);
  });

  it('忽略空段(连续斜杠、末尾斜杠都不该多出一个空 id)', () => {
    // 空 id 会变成祖先链里的一个幽灵节点:判定时查不到它,
    // 于是「某个祖先不存在」这种诡异状态会被一路带下去。
    expect(idsOfPath('/a//b')).toEqual(['a', 'b']);
    expect(idsOfPath('/a/b/')).toEqual(['a', 'b']);
    expect(idsOfPath('//a')).toEqual(['a']);
  });

  it('空字符串与只有斜杠 → 空数组(不抛错)', () => {
    expect(idsOfPath('')).toEqual([]);
    expect(idsOfPath('/')).toEqual([]);
  });
});

describe('subtreePrefix —— 末尾的斜杠不能省', () => {
  it('返回带末尾斜杠的前缀', () => {
    expect(subtreePrefix('/a/b')).toBe('/a/b/');
  });

  it('★★ 少了斜杠就会把 /a/b-1 当成 /a/b 的后代', () => {
    // 这是本仓库里唯一被实测抓到过的路径坑(见 DESIGN §8.1)。
    // 它同时影响「移动时防环」与「组织范围判定」两处,
    // 而表现只是「偶尔能拖到一个不该拖进去的地方」。
    const prefix = subtreePrefix('/a/b');
    expect('/a/b/doc'.startsWith(prefix)).toBe(true);
    expect('/a/b-1'.startsWith(prefix)).toBe(false);
    expect('/a/b-1/doc'.startsWith(prefix)).toBe(false);
  });

  it('前缀不会误伤自己(自身不算自己的后代)', () => {
    expect('/a/b'.startsWith(subtreePrefix('/a/b'))).toBe(false);
  });
});

describe('depthOfPath —— 根为 0', () => {
  it('按层数返回', () => {
    expect(depthOfPath('/a')).toBe(0);
    expect(depthOfPath('/a/b')).toBe(1);
    expect(depthOfPath('/a/b/c')).toBe(2);
  });

  it('空路径是 -1(没有任何层)', () => {
    expect(depthOfPath('/')).toBe(-1);
  });
});

describe('prefixPathsOf —— 自身 + 全部祖先', () => {
  it('从根开始,并把自身放在最后', () => {
    // 顺序有语义:判定拿它去查祖先链,而「根在前」是权限模型的方向
    // (越靠上权限越大)。反过来的话断言全都会反过来,很难查。
    expect(prefixPathsOf('/a/b/c')).toEqual(['/a', '/a/b', '/a/b/c']);
  });

  it('★ 含自身 —— 判定必须能取到自己的所有者与可见性', () => {
    expect(prefixPathsOf('/a/b')).toContain('/a/b');
  });

  it('★ 返回的前缀不带末尾斜杠(它是路径,不是 LIKE 模式)', () => {
    // 带了的话会和 subtreePrefix 混用,而那种混用不会报错:
    // 精确相等查询末尾多一个斜杠会一条都查不到,
    // 表现是「祖先链变成空的,所有人都失去上级权限」。
    for (const path of prefixPathsOf('/a/b/c')) {
      expect(path.endsWith('/')).toBe(false);
    }
  });

  it('单层路径只有它自己', () => {
    expect(prefixPathsOf('/a')).toEqual(['/a']);
  });

  it('空路径 → 空数组', () => {
    expect(prefixPathsOf('/')).toEqual([]);
  });
});

describe('rootIdOfPath —— 一级节点(权限缓存按它分片)', () => {
  it('取第一个 id', () => {
    expect(rootIdOfPath('/dept/grp/doc')).toBe('dept');
    expect(rootIdOfPath('/dept')).toBe('dept');
  });

  it('空路径返回空串(不用 undefined 污染缓存键)', () => {
    expect(rootIdOfPath('/')).toBe('');
    expect(rootIdOfPath('')).toBe('');
  });
});

describe('renderPath —— 给人看的面包屑', () => {
  it('按 id → 标题映射渲染,用「 / 」连接', () => {
    const titles = new Map([
      ['dept', '技术部'],
      ['grp', '后端组'],
    ]);
    expect(renderPath('/dept/grp', titles)).toBe('技术部 / 后端组');
  });

  it('★ 查不到标题时回退成 id,而不是留空', () => {
    // 留空的表现是面包屑里出现一个空洞(「技术部 /  / 接口规范」),
    // 用户完全不知道自己在哪一层。回退成 id 至少是可排查的。
    const titles = new Map([['dept', '技术部']]);
    expect(renderPath('/dept/unknown', titles)).toBe('技术部 / unknown');
  });

  it('空路径渲染成空串', () => {
    expect(renderPath('/', new Map())).toBe('');
  });
});
