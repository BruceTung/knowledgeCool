/**
 * @knowledgecool/shared —— 前后端共享的唯一事实来源。
 *
 * 这个包是选「全 TypeScript 技术栈」的最大收益点(DESIGN.md §7.1):
 * 角色枚举、权限矩阵、错误码只定义一次,前后端同时受益。
 *
 * 模块制式:**ESM**(`package.json` 里 `"type": "module"` + tsconfig `module: nodenext`)。
 * 与后端一致 —— NestJS 12 是 ESM-only(DESIGN.md §2.5 结论一),全链路统一 ESM,
 * 不必依赖 `require(esm)` 互操作。
 *
 * 副作用是这个包不能有 Node 专有依赖 —— 它必须保持**纯逻辑、零 IO**,
 * 这样前端 Vite 也能直接消费。
 */

export * from './roles.js';
export * from './errors.js';
export * from './dto.js';
export * from './permission.js';
export * from './auth.js';
export * from './space.js';
