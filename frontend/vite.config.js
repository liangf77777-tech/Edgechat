import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildMetadata } from './build-metadata.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const buildMetadata = resolveBuildMetadata();

export default defineConfig({
  root: resolve(dirname),
  plugins: [vue()],
  define: {
    'globalThis.__EDGECHAT_BUILD__': JSON.stringify(buildMetadata),
    'globalThis.__EDGECHAT_DEMO__': 'false'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      },
      '/files': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: resolve(dirname, 'dist'),
    emptyOutDir: true,
    // Vite 8 默认 target 是 baseline-widely-available（Chrome 107 / Safari 16），
    // 产物会保留可选链、空值合并、类字段等语法。微信 X5 老内核、UC、QQ 浏览器、
    // iOS 13/14 自带 Safari 解析到这些语法会直接整体失败 —— 表现就是手机端白屏。
    // 降至 es2015（Vue 3 的运行底线），配合 public/compat.js 补齐运行时 API。
    target: 'es2015',
    // CSS 侧同理：older WebKit 需要前缀，且不能输出 :is()/:where() 等新选择器。
    cssTarget: ['chrome61', 'safari11'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // 共用摇树后的图标集合，避免每个小图标都产生独立请求。
            { name: 'icons', test: /node_modules[\\/]@lucide[\\/]vue[\\/]/ }
          ]
        }
      }
    }
  }
});
