/**
 * @knowledgecool/shared —— 前后端共享的唯一事实来源。
 *
 * 这个包是选「全 TypeScript 技术栈」的最大收益点(DESIGN.md §7.1):
 * 权限判定的纯函数、错误码、DTO 类型只定义一次,前后端同时受益。
 *
 * 模块制式:**ESM**(`package.json` 里 `"type": "module"` + tsconfig `module: nodenext`)。
 * 与后端一致 —— NestJS 12 是 ESM-only(DESIGN.md §2.5 结论一),全链路统一 ESM,
 * 不必依赖 `require(esm)` 互操作。
 *
 * 副作用是这个包不能有 Node 专有依赖 —— 它必须保持**纯逻辑、零 IO**,
 * 这样前端 Vite 也能直接消费。
 *
 * ⚠️ **v2.0 起的模块变更**:
 *   - 删除 `roles.ts`(五档角色枚举 + 能力矩阵 —— 整个模型里已经没有"角色"了)
 *   - 删除 `space.ts`(空间并入节点树,组织与人员类型见 `org.ts`)
 *   - 删除 `permission-dto.ts`(deny/继承规则作废,改为授权名单,见 `grant.ts`)
 *   - `page.ts` → `node.ts`(空间与页面合并);`permission.ts` 整体重写
 */

export * from './permission.js';
export * from './errors.js';
export * from './dto.js';
export * from './auth.js';
export * from './node.js';
export * from './grant.js';
export * from './visibility.js';
export * from './org.js';
export * from './content.js';
export * from './search.js';
export * from './comment.js';
export * from './audit.js';
export * from './csv.js';
