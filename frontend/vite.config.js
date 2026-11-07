import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildMetadata } from './build-metadata.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const buildMetadata = resolveBuildMetadata();

// legacy 备份包：给完全不支持 ES Module 的内核（iOS < 11 / Chrome < 61 /
// 老 Android WebView）准备一份 SystemJS + ES5 的 nomodule 构建。
// 实际下限是「支持 Proxy」的内核（iOS 10+ / Chrome 49+）；再老的内核没有
// Proxy，Vue 3 本身无法运行，由 public/compat.js 给出升级提示。
// 用 try/catch 包住加载：插件缺失时只产出现代包，构建不会整体失败。
const plugins = [vue()];
try {
  const { default: legacy } = await import('@vitejs/plugin-legacy');
  plugins.push(
    legacy({
      targets: ['chrome >= 49', 'ios >= 10', 'safari >= 10', 'edge >= 12', 'firefox >= 45'],
      modernPolyfills: false,
      // plugin-legacy 会用 modernTargets 覆盖 build.target（它默认是 es2020），
      // 不显式指定就会把现代包重新抬回可选链/空值合并 —— 老内核再次白屏。
      // 这里锁到 ES2015 对应的浏览器区间，和下方 build.target 保持一致。
      modernTargets: ['chrome >= 51', 'safari >= 10', 'edge >= 15', 'firefox >= 54'],
      // 关掉 core-js 自动补丁：目标下限 iOS 10 / Chrome 49 已内置全部 ES2015
      // 内置对象（Promise / Map / Set / Symbol / Proxy），缺的只是语法转换。
      // 少一个 core-js 依赖也少一处构建失败面；ES2022 的新 API 由
      // public/compat.js 在运行时补齐。
      polyfills: false,
      renderLegacyChunks: true
    })
  );
} catch (error) {
  console.warn('[edgechat] legacy 备份包未启用：', error && error.message ? error.message : error);
}

// 注意：这里必须导出「对象」而不是工厂函数。
// demo 与 capacitor 的构建配置都用 mergeConfig(baseConfig, ...) 合并本配置，
// 导出工厂函数会直接让它们抛错。
export default defineConfig({
  root: resolve(dirname),
  plugins,
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
