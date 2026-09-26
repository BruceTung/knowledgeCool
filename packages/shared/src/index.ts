/**
 * @knowledgecool/shared —— 前后端共享的唯一事实来源。
 *
 * 这个包是选「全 TypeScript 技术栈」的最大收益点(DESIGN.md §7.1):
 * 角色枚举、权限矩阵、错误码只定义一次,前后端同时受益。
 *
 * 编译为 CommonJS:后端 NestJS 是 CJS,前端 Vite 消费 CJS 无碍。
 * 副作用是这个包不能有 Node 专有依赖 —— 它必须保持**纯逻辑、零 IO**。
 */

export * from './roles.js';
export * from './errors.js';
export * from './dto.js';
export * from './permission.js';
export * from './auth.js';
