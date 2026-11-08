import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  stripLegacyGuardProbe,
  hasLegacyGuardProbe,
  legacyGuardProbePlugin
} from '../frontend/legacy-guard-probe.js';

const read = (relative) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * 这一组锁定线上故障：@vitejs/plugin-legacy v8 用
 * `import.meta.resolve` 当「新内核」判据，并在产物里插入会主动抛错的探针。
 * 该 API 只有 Chrome 105+ / Safari 16.4+ 才有，于是 iOS 12~16.3 与
 * Android WebView < 105 一进页面就抛 `import.meta.resolve not supported`。
 */

// plugin-legacy 真实生成的两种形态（未压缩）。
const CHUNK_GUARD =
  'import\'data:text/javascript,"assets/index-BHAI846W.js";if(!import.meta.resolve)' +
  'throw Error("import.meta.resolve not supported")\';' +
  'export function __vite_legacy_guard(){import.meta.url;import("_").catch(()=>1);' +
  '(async function*(){})().next()};';

const HTML_INLINE =
  'import\'data:text/javascript,if(!import.meta.resolve)throw Error(' +
  '"import.meta.resolve not supported")\';import.meta.url;import("_").catch(()=>1);' +
  '(async function*(){})().next();window.__vite_is_modern_browser=true';

test('删掉入口 chunk 顶部的探针，其余代码原样保留', () => {
  const out = stripLegacyGuardProbe(CHUNK_GUARD);

  assert.doesNotMatch(out, /import\.meta\.resolve not supported/);
  assert.doesNotMatch(out, /data:text\/javascript/);
  assert.match(out, /export function __vite_legacy_guard/);
  // 语法完整性：剩下的仍然是能解析的 ES module。
  assert.ok(out.trimStart().startsWith('export function'), '只应删掉开头那段 import');
});

test('删掉 index.html 内联 module 里的探针，但保留现代内核探测', () => {
  const out = stripLegacyGuardProbe(HTML_INLINE);

  assert.doesNotMatch(out, /throw Error/);
  assert.match(out, /import\.meta\.url/, '语法探测必须保留');
  assert.match(out, /\(async function\*\(\)\{\}\)\(\)\.next\(\)/, 'async generator 探测必须保留');
  assert.match(out, /window\.__vite_is_modern_browser=true/, '探测通过后必须置位');
});

test('预加载助手里的 import.meta.resolve 兜底三元表达式不能被误删', () => {
  const preload =
    'function s(e){return import.meta.resolve?import.meta.resolve(e):new URL(e,import.meta.url).href}';
  assert.equal(stripLegacyGuardProbe(preload), preload, '带兜底的正常用法必须保留');
});

test('压缩后（双引号 + 转义）的形态同样能删干净', () => {
  const minified =
    'import"data:text/javascript,\\"assets/index-x.js\\";if(!import.meta.resolve)throw Error(' +
    '\\"import.meta.resolve not supported\\")";export function __vite_legacy_guard(){}';
  const out = stripLegacyGuardProbe(minified);
  assert.equal(hasLegacyGuardProbe(out), false);
  assert.match(out, /^export function __vite_legacy_guard/);
});

test('幂等：重复处理不会破坏已经干净的代码', () => {
  const once = stripLegacyGuardProbe(CHUNK_GUARD);
  assert.equal(stripLegacyGuardProbe(once), once);
});

test('Vite 配置挂上了去探针插件，且仍保留 legacy 备份包', async () => {
  const config = await read('../frontend/vite.config.js');
  assert.match(config, /legacyGuardProbePlugin\(\)/, '必须启用去探针插件');
  assert.match(config, /@vitejs\/plugin-legacy/, 'legacy 备份包仍需保留');
});

test('插件会清理 chunk 与 index.html，并在漏删时让构建失败', () => {
  const plugin = legacyGuardProbePlugin();
  assert.equal(plugin.enforce, 'post', '必须排在 plugin-legacy 之后执行');

  assert.equal(plugin.renderChunk(CHUNK_GUARD).code.startsWith('export function'), true);
  assert.equal(plugin.renderChunk('const a = 1;'), null, '无关代码不做处理');

  const ctx = {
    error(message) {
      throw new Error(message);
    }
  };

  const bundle = {
    'index.html': { type: 'asset', source: `<script type="module">${HTML_INLINE}</script>` },
    'assets/index.js': { type: 'chunk', code: CHUNK_GUARD }
  };
  plugin.generateBundle.call(ctx, {}, bundle);
  assert.equal(hasLegacyGuardProbe(bundle['index.html'].source), false, 'html 必须被清理');
  assert.equal(hasLegacyGuardProbe(bundle['assets/index.js'].code), false, 'chunk 必须被清理');

  // 认不出的新形态不能静默放行，必须让构建失败而不是把坏包发上线。
  const unknown = {
    'assets/index.js': {
      type: 'chunk',
      code: 'if(!import.meta.resolve)throw Error("import.meta.resolve not supported")'
    }
  };
  assert.throws(
    () => plugin.generateBundle.call(ctx, {}, unknown),
    /legacy 探针没有被移除/
  );
});
