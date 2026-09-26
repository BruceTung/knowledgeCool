import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // 开发期把 /api 代理到本地 API,避免跨域并让 Cookie 同源。
    // 生产环境由 Nginx 承担同样职责(docker/nginx.conf)。
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },

  test: {
    // 只测纯逻辑(请求封装、后续的权限展示逻辑),不引入 jsdom。
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
