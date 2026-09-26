import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint 扁平配置(ESLint 9+ 的唯一形式)。
 *
 * 两点说明:
 * 1. **不做 type-aware 检查**(不用 recommendedTypeChecked)。
 *    type-aware 需要为每个文件指定 project,在本 monorepo 里配置成本高、跑得也慢,
 *    而它多抓到的那类问题,`pnpm typecheck` 已经覆盖了。lint 负责风格与可疑写法。
 * 2. `apps/api/src/generated` 必须忽略 —— 那是 Prisma 生成的代码,
 *    虽然有 @ts-nocheck 与 eslint-disable 头,忽略掉可以省掉大量解析开销。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'prototype/**',
      'apps/api/src/generated/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // 用 === 而不是 ==,避免隐式类型转换带来的诡异判断
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 权限判定相关的代码里,显式 any 会绕过类型安全,这里收紧
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // 前端:浏览器全局 + React Hooks 规则
  // 注意:react-hooks 的 configs['recommended-latest'] 是**旧的 eslintrc 形状**
  // (plugins 是字符串数组),直接把扁平配置喂给 ESLint 10 会直接报错。
  // 扁平版本在 configs.flat 下。
  {
    ...reactHooks.configs.flat.recommended,
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // 脚本与构建配置里允许直接 console(它们就是命令行工具)
  {
    files: ['apps/api/scripts/**/*.mjs', '**/*.config.{ts,mjs,js}', 'eslint.config.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  // 必须放最后:关掉所有与格式化冲突的规则,格式化统一交给 Prettier
  prettier,
);
