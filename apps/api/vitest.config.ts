import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置 —— 单元测试。
 *
 * ⚠️ `unplugin-swc` **不是可选项**。NestJS 的依赖注入靠 TypeScript 的
 * `emitDecoratorMetadata` 产出 `design:paramtypes`;而 Vite/Vitest 默认的
 * esbuild 转译器**不产出这个元数据**(实测:即使 tsconfig 里开了
 * emitDecoratorMetadata,esbuild 的输出里也没有 design:paramtypes)。
 * 结果是 `Test.createTestingModule({ providers: [X] })` 里凡是「按构造函数类型注入」
 * 的地方都会解析失败。
 *
 * NestJS 官方文档在 Vitest 一节里明确要求装 unplugin-swc,并注明
 * "This is required to build the test files with SWC"。
 * 这里把 legacyDecorator / decoratorMetadata 显式写出来,不依赖默认值。
 */
export default defineConfig({
  plugins: [
    tsconfigPaths(),
    swc.vite({
      // 显式指定模块制式,避免被 .swcrc 之类的配置带偏
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    root: './',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
