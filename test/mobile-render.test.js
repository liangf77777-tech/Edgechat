import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { onMediaQueryChange, safeMatchMedia } from '../frontend/src/media-query.js';

const read = (relative) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('index.html 先在模块脚本之前同步加载兼容层，并声明移动端 viewport', async () => {
  const html = await read('../frontend/index.html');
  assert.match(html, /name="viewport"[^>]*width=device-width/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /<script src="\/compat\.js"><\/script>/);
  assert.match(html, /<noscript>/);

  const compatIndex = html.indexOf('<script src="/compat.js"></script>');
  const moduleIndex = html.indexOf('type="module"');
  assert.ok(compatIndex > -1 && moduleIndex > compatIndex, '兼容层必须在 module 之前');
  assert.doesNotMatch(
    html.slice(compatIndex, compatIndex + 60),
    /defer|async/,
    '兼容层不能延迟执行，否则老内核仍会在模块顶层崩溃'
  );
});

test('兼容层保持纯 ES5：不出现可选链、空值合并、模板字符串或箭头函数', async () => {
  const source = await read('../frontend/public/compat.js');
  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /\?\?/);
  assert.doesNotMatch(source, /=>/);
  assert.doesNotMatch(source, /`/);
  assert.doesNotMatch(source, /\b(?:const|let|class)\s/);
  assert.match(source, /Object\.hasOwn/);
  assert.match(source, /--chat-viewport-height/);
  assert.match(source, /MediaQueryList/);
});

test('构建目标降到 es2015，避免新语法让老内核整体解析失败', async () => {
  const config = await read('../frontend/vite.config.js');
  assert.match(config, /target:\s*'es2015'/);
  assert.match(config, /cssTarget:/);
});

test('入口保证「先挂载、后增强」，语言包失败也不阻塞渲染', async () => {
  const main = await read('../frontend/src/main.js');
  assert.match(main, /styles\/mobile\.css/);
  assert.match(main, /Promise\.resolve\(i18nReady\)[\s\S]*\.catch\(/);

  const mountIndex = main.indexOf('app.mount(\'#app\')');
  // 顶部 import 里也出现同名符号，用 lastIndexOf 定位真正的初始化调用。
  const glassIndex = main.lastIndexOf('initLiquidGlass');
  assert.ok(mountIndex > -1 && glassIndex > mountIndex, '增强能力必须在挂载之后初始化');
  assert.match(main, /function safeRun/);
});

test('移动端样式关闭重型滤镜并修正触摸细节', async () => {
  const css = await read('../frontend/src/styles/mobile.css');
  assert.match(css, /backdrop-filter: none !important/);
  assert.match(css, /font-size: 16px !important/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /-webkit-text-size-adjust: 100%/);
  assert.match(css, /-webkit-overflow-scrolling: touch/);
  assert.match(css, /env\(safe-area-inset-/);
});

test('聊天页高度不再依赖 100dvh 作为唯一回退', async () => {
  const page = await read('../frontend/src/pages/ChatPage.vue');
  assert.match(page, /height: var\(--chat-viewport-height, 100vh\)/);
  assert.match(page, /min-height: 100vh/);
  assert.doesNotMatch(page, /var\(--chat-viewport-height, 100dvh\)/);

  const app = await read('../frontend/src/App.vue');
  assert.match(app, /min-height: 100vh;\s*min-height: 100dvh;/);
});

test('Service Worker 不再拦截导航请求', async () => {
  const sw = await read('../frontend/public/sw.js');
  assert.doesNotMatch(sw, /event\.respondWith/);
  assert.match(sw, /addEventListener\('fetch'/);
});

test('i18n 模块顶层不再调用老内核缺失的运行时 API', async () => {
  const i18n = await read('../frontend/src/i18n.js');
  assert.doesNotMatch(i18n, /Object\.hasOwn\(/);
  assert.doesNotMatch(i18n, /\.replaceAll\(/);
  assert.match(i18n, /function readStoredLocale/);
  assert.match(i18n, /dateStyle: 'medium'/);
  assert.match(i18n, /DATETIME_FALLBACK/);
});

test('媒体查询监听不再直接调用 addEventListener(change)', async () => {
  for (const file of ['visual-effects.ts', 'liquid-glass.ts']) {
    const source = await read(`../frontend/src/${file}`);
    assert.doesNotMatch(source, /\.addEventListener\('change'/);
    assert.match(source, /onMediaQueryChange/);
    assert.match(source, /safeMatchMedia/);
  }
});

test('视口判断首帧就与 CSS 媒体查询一致', async () => {
  const viewport = await read('../frontend/src/composables/useChatViewport.js');
  assert.match(viewport, /function detectMobileViewport/);
  assert.match(viewport, /ref\(detectMobileViewport\(\)\)/);
  assert.match(viewport, /orientationchange/);
});

test('safeMatchMedia 在缺失或抛错的 matchMedia 上返回安全桩', () => {
  const missing = safeMatchMedia('(hover: hover)', {});
  assert.equal(missing.matches, false);
  assert.equal(typeof missing.addEventListener, 'function');

  const throwing = safeMatchMedia('(prefers-reduced-transparency: reduce)', {
    matchMedia() { throw new Error('unsupported feature'); }
  });
  assert.equal(throwing.matches, false);
  assert.equal(typeof throwing.addListener, 'function');
});

test('onMediaQueryChange 优先 addEventListener，老内核回退 addListener', () => {
  let modernAttached = null;
  let modernDetached = null;
  const modern = {
    addEventListener(type, fn) { modernAttached = type + ':' + typeof fn; },
    removeEventListener(type, fn) { modernDetached = type + ':' + typeof fn; }
  };
  const offModern = onMediaQueryChange(modern, () => {});
  assert.equal(modernAttached, 'change:function');
  offModern();
  assert.equal(modernDetached, 'change:function');

  let legacyAttached = false;
  let legacyDetached = false;
  const legacy = {
    addListener(fn) { legacyAttached = typeof fn === 'function'; },
    removeListener(fn) { legacyDetached = typeof fn === 'function'; }
  };
  const offLegacy = onMediaQueryChange(legacy, () => {});
  assert.equal(legacyAttached, true);
  offLegacy();
  assert.equal(legacyDetached, true);

  assert.doesNotThrow(() => onMediaQueryChange(null, () => {})());
  assert.doesNotThrow(() => onMediaQueryChange({}, () => {})());
});
