import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (relative) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const readCompat = () => readFile(compatPath, 'utf8');

const compatPath = fileURLToPath(new URL('../frontend/public/compat.js', import.meta.url));

/**
 * 这一组测试锁定「加载中闪一下然后白屏」的回归：
 *   1. #app 里必须有首字节就能渲染的静态占位；
 *   2. 挂载必须等路由解析完成（否则 RouterView 会渲染空树）；
 *   3. 界面最终没画出来时必须自动给出可操作的提示，而不是纯白。
 */
test('index.html 在 #app 内提供不依赖 JS/CSS 的静态首屏占位', async () => {
  const html = await read('../frontend/index.html');

  const appStart = html.indexOf('<div id="app">');
  const splashIndex = html.indexOf('id="boot-splash"');
  const appEnd = html.indexOf('</div>', splashIndex);

  assert.ok(appStart > -1, '必须保留 #app 挂载点');
  assert.ok(splashIndex > appStart, '静态占位必须在 #app 内部，Vue 挂载时才会被整体替换');
  assert.ok(appEnd > splashIndex, '静态占位必须有闭合标签');

  // 占位必须是内联样式：外链 CSS 还没下载完时也要能画出来。
  assert.match(html, /id="boot-splash"[\s\S]{0,600}?position:fixed/);
  assert.match(html, /id="boot-splash"[\s\S]{0,600}?background:#fefdf8/);
  assert.doesNotMatch(html, /<link[^>]+boot-splash/, '占位不能依赖外链样式');
});

test('入口先等路由解析再挂载，避免 RouterView 在路由未就绪时渲染空树', async () => {
  const main = await read('../frontend/src/main.js');

  assert.match(main, /router\.isReady\(\)/, '挂载前必须等待路由就绪');
  assert.match(main, /Promise\.race\(\[routeReady, readyTimeout\]\)/, '弱网下必须有超时兜底');
  assert.match(main, /setTimeout\(resolve, 6000\)/, '超时时间应足够覆盖弱网首屏');

  const mountIndex = main.indexOf("app.mount('#app')");
  const raceIndex = main.indexOf('Promise.race([routeReady, readyTimeout])');
  assert.ok(mountIndex > -1 && raceIndex > -1);
  assert.ok(mountIndex > raceIndex, '挂载必须发生在路由就绪之后');
});

test('Vue 内部渲染错误会上报给兼容层，不再静默变空白', async () => {
  const main = await read('../frontend/src/main.js');
  assert.match(main, /app\.config\.errorHandler\s*=/, '必须注册 Vue 错误处理器');
  assert.match(main, /reportFatal/, '错误必须上报给兼容层的可见提示');
});

test('兼容层暴露 reportFatal，并在界面缺失时给出清缓存入口', async () => {
  const source = await readCompat();
  assert.match(source, /reportFatal:\s*reportFatal/);
  assert.match(source, /hardReload/);
  assert.match(source, /清除缓存并重新加载/);
  assert.match(source, /getRegistrations/, '清缓存重载应注销旧 Service Worker');
  assert.match(source, /caches\.keys/, '清缓存重载应清空 Cache Storage');
});

function createSandbox({ withSplash = false, moduleSupport = true } = {}) {
  const timers = [];
  const listeners = {};
  const bodyChildren = [];
  const appEl = { children: [], innerHTML: '', appendChild() {} };
  const splashEl = { id: 'boot-splash' };

  function makeElement() {
    return {
      children: [],
      style: { cssText: '' },
      setAttribute() {},
      appendChild(node) {
        this.children.push(node);
        return node;
      }
    };
  }

  const doc = {
    documentElement: {
      clientHeight: 844,
      style: { setProperty() {}, removeProperty() {} }
    },
    body: {
      children: bodyChildren,
      appendChild(node) {
        bodyChildren.push(node);
        return node;
      }
    },
    getElementById(id) {
      if (id === 'app') return appEl;
      if (id === 'boot-splash' && withSplash) return splashEl;
      return null;
    },
    createElement(tag) {
      const node = makeElement();
      if (tag === 'script' && moduleSupport) node.noModule = false;
      return node;
    },
    createTextNode(text) {
      return { text: String(text) };
    }
  };

  const sandbox = {
    document: doc,
    innerWidth: 390,
    innerHeight: 844,
    navigator: { userAgent: 'test', language: 'zh-CN' },
    location: { reload() {}, href: 'https://example.test/', replace() {} },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    setTimeout(fn, delay) {
      timers.push({ fn, delay: delay || 0 });
      return timers.length;
    },
    clearTimeout() {},
    console
  };
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {}
  };
  sandbox.sessionStorage = sandbox.localStorage;

  const context = vm.createContext(sandbox);
  return {
    context,
    bodyChildren,
    appEl,
    flushTimers(maxDelay) {
      const limit = maxDelay === undefined ? Infinity : maxDelay;
      const pending = timers.splice(0, timers.length);
      const due = pending.filter((item) => item.delay <= limit);
      const rest = pending.filter((item) => item.delay > limit);
      for (const item of rest) timers.push(item);
      for (const item of due) item.fn();
      return due.length;
    }
  };
}

test('静态占位还在时，看门狗不会提前弹「界面没有显示出来」', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: true });
  vm.runInContext(source, env.context);

  // 6.5 秒看门狗：占位仍在 → 视为仍在加载，不提示。
  env.flushTimers(7000);
  assert.equal(env.bodyChildren.length, 0, '还在加载时不应打断用户');

  // 12 秒仍停在占位 → 提示「加载较慢」，并给出清缓存入口。
  env.flushTimers();
  assert.equal(env.bodyChildren.length, 1);
  const text = JSON.stringify(env.bodyChildren[0]);
  assert.match(text, /加载较慢/);
  assert.match(text, /清除缓存并重新加载/);
});

test('占位已被替换但界面为空时，看门狗给出白屏提示', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: false });
  vm.runInContext(source, env.context);

  env.flushTimers(7000);
  assert.equal(env.bodyChildren.length, 1, '白屏必须被主动发现');
  assert.match(JSON.stringify(env.bodyChildren[0]), /界面没有显示出来/);
});

test('聊天页那种「子节点 fixed、#app 高度为 0」的正常界面不会被误判为白屏', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: false });
  vm.runInContext(source, env.context);

  // 线上真实结构：#app 自身高度 0，.chat-layout 是 position:fixed 的 390x844。
  env.appEl.getBoundingClientRect = () => ({ width: 390, height: 0 });
  env.appEl.children.push({
    className: 'chat-layout',
    getBoundingClientRect: () => ({ width: 390, height: 844 }),
  });

  env.flushTimers();
  assert.equal(env.bodyChildren.length, 0, '固定定位的聊天布局不能被当成白屏');
});

test('界面正常渲染后看门狗保持沉默', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: false });
  vm.runInContext(source, env.context);

  env.appEl.children.push({ id: 'page' });

  env.flushTimers();
  assert.equal(env.bodyChildren.length, 0, '正常界面不能被兜底提示覆盖');
});

test('构建同时产出 es2015 现代包与 legacy 备份包，且不让插件抬回新语法', async () => {
  const config = await read('../frontend/vite.config.js');
  assert.match(config, /@vitejs\/plugin-legacy/, '必须启用 legacy 备份包');
  assert.match(config, /targets:/, 'legacy 目标必须显式声明');
  // plugin-legacy 默认把 modern target 设成 es2020，必须显式压回 ES2015，
  // 否则现代包会重新带上可选链/空值合并，iOS 13 / 微信 X5 又白屏。
  assert.match(config, /modernTargets:/, '必须锁定 modernTargets，避免 target 被覆盖');
  assert.match(config, /target:\s*'es2015'/);

  const pkg = await read('../package.json');
  assert.match(pkg, /@vitejs\/plugin-legacy/, '插件必须写进 devDependencies');
});

test('不支持 ES Module 且始终没有界面时，提示升级而不是泛化白屏', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: false, moduleSupport: false });
  vm.runInContext(source, env.context);

  env.flushTimers(7000);
  assert.equal(env.bodyChildren.length, 1);
  assert.match(JSON.stringify(env.bodyChildren[0]), /浏览器版本过旧/);
});
