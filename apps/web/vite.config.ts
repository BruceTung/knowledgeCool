import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
    /*
      ⚠️ **生产构建不出 source map。**
      Vite 的 map 里内嵌 `sourcesContent` —— 也就是把**整个前端源码**(含全部
      中文注释、内部判断与 TODO)原样打包成 `dist/assets/*.js.map`。
      原来这里是 `true`,于是那份 3.9 MB 的 map 会跟着静态资源一起被部署出去,
      任何能访问这个站点的人都能把源码下载下来。
      这是个内网知识库,源码本身不算机密,但"顺手把源码发出去"不该是默认行为。

      需要排障时改成 `'hidden'`(生成但不写 sourceMappingURL),再在
      `docker/nginx.conf` 里对 `*.map` 直接 `deny all`。
    */
    sourcemap: false,
  },
});
