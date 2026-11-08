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
 *   1. 首屏必须有首字节就能渲染的静态占位，且它不能放在 #app 里 ——
 *      放在里面会被 Vue 挂载时一并清掉，路由没解析出来时页面就纯白；
 *   2. 挂载必须等路由解析完成（否则 RouterView 会渲染空树）；
 *   3. 「有没有内容」的判据不能把注释节点当成内容：RouterView 未解析时
 *      只渲染 <!---->，旧判据据此认为界面正常，于是白屏且没有任何提示；
 *   4. 界面最终没画出来时必须自动给出可操作、可复制的提示。
 */
test('静态首屏占位在 #app 之外，不会被 Vue 挂载一并清掉', async () => {
  const html = await read('../frontend/index.html');

  const appIndex = html.indexOf('<div id="app">');
  const splashIndex = html.indexOf('id="boot-splash"');
  assert.ok(appIndex > -1, '必须保留 #app 挂载点');
  assert.ok(splashIndex > -1, '必须保留静态首屏占位');

  // #app 必须是空容器：占位一旦落在里面，mount() 会把它连内容一起替换掉。
  assert.match(html, /<div id="app"><\/div>/, '#app 必须是空容器，占位不能放在里面');
  assert.ok(splashIndex > appIndex, '占位必须在 #app 之后作为独立节点存在');

  // 占位必须是内联样式：外链 CSS 还没下载完时也要能画出来。
  assert.match(html, /id="boot-splash"[\s\S]{0,600}?position:fixed/);
  assert.match(html, /id="boot-splash"[\s\S]{0,600}?background:#fefdf8/);
  assert.doesNotMatch(html, /<link[^>]+boot-splash/, '占位不能依赖外链样式');
});

test('占位由兼容层托管：确认画出内容才移除', async () => {
  const source = await readCompat();
  assert.match(source, /function removeSplash\(/, '必须有显式的占位移除逻辑');
  assert.match(source, /function paintConfirmed\(/, '移除占位前必须确认界面已绘制');
  assert.match(source, /MutationObserver/, '内容出现时应立即撤掉占位');
  assert.match(source, /function paintConfirmed\(\)[\s\S]{0,240}?removeSplash\(\)/, '判定与移除必须成对出现');
});

test('入口先等路由解析再挂载，并在挂载后继续自愈', async () => {
  const main = await read('../frontend/src/main.js');

  assert.match(main, /router\.isReady\(\)/, '挂载前必须等待路由就绪');
  assert.match(main, /Promise\.race\(\[routeReady, readyTimeout\]\)/, '弱网下必须有超时兜底');
  assert.match(main, /setTimeout\(resolve, 6000\)/, '超时时间应足够覆盖弱网首屏');

  const mountIndex = main.indexOf("app.mount('#app')");
  const raceIndex = main.indexOf('Promise.race([routeReady, readyTimeout])');
  assert.ok(mountIndex > -1 && raceIndex > -1);
  assert.ok(mountIndex > raceIndex, '挂载必须发生在路由就绪之后');

  // 超时挂载时路由可能仍然是空的，必须有挂载后的自愈与上报。
  assert.match(main, /function ensurePainted\(/, '必须有挂载后的首屏自愈');
  assert.match(main, /ensure-painted/, '自愈必须在挂载后被调用');
  assert.match(main, /replace\('\/login'\)/, '空路由应退回登录页重试');
  assert.match(main, /routeUnmatched\(/, '只有路由真的没匹配上才介入，避免打断正常加载');
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
  assert.match(source, /复制诊断信息/, '手机端要能把现场带回来');
});

function createSandbox({ withSplash = false, moduleSupport = true } = {}) {
  const timers = [];
  const listeners = {};
  const bodyChildren = [];
  const appEl = { children: [], innerHTML: '', textContent: '', appendChild() {} };
  const splashEl = { id: 'boot-splash' };

  function makeElement() {
    return {
      children: [],
      parentNode: null,
      style: { cssText: '' },
      setAttribute() {},
      appendChild(node) {
        this.children.push(node);
        return node;
      }
    };
  }

  const body = {
    children: bodyChildren,
    appendChild(node) {
      // parentNode 是双向指针，设成不可枚举，避免测试里 JSON.stringify 成环。
      Object.defineProperty(node, 'parentNode', {
        value: body,
        enumerable: false,
        configurable: true,
        writable: true
      });
      bodyChildren.push(node);
      return node;
    },
    removeChild(node) {
      const index = bodyChildren.indexOf(node);
      if (index > -1) bodyChildren.splice(index, 1);
      node.parentNode = null;
      return node;
    }
  };

  const doc = {
    documentElement: {
      clientHeight: 844,
      style: { setProperty() {}, removeProperty() {} },
      appendChild(node) {
        body.appendChild(node);
      }
    },
    body,
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
    listeners,
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

test('占位已移除但界面为空时，看门狗给出白屏提示', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: false });
  vm.runInContext(source, env.context);

  env.flushTimers(7000);
  assert.equal(env.bodyChildren.length, 1, '白屏必须被主动发现');
  assert.match(JSON.stringify(env.bodyChildren[0]), /界面没有显示出来/);
});

/**
 * 线上真实故障：Vue 已挂载、占位被清掉，但路由还没解析出来，
 * <router-view> 只渲染一个注释占位。此时 #app.innerHTML 是 "<!---->"，
 * 非空！旧判据据此认定「界面已渲染」，看门狗全程沉默 → 用户看到永久白屏。
 */
test('只有注释节点的 #app 必须判为白屏，不能被 innerHTML 骗过去', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: false });
  vm.runInContext(source, env.context);

  // 真实 DOM 里注释不是 Element，所以 children 为空；innerHTML 却是 "<!---->"。
  env.appEl.innerHTML = '<!---->';
  env.appEl.textContent = '';

  env.flushTimers(7000);
  assert.equal(env.bodyChildren.length, 1, '注释节点不算内容，必须提示白屏');
  assert.match(JSON.stringify(env.bodyChildren[0]), /界面没有显示出来/);
});

test('只有 App 自身的「读取中」加载态时，不算界面已绘制', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: true });
  vm.runInContext(source, env.context);

  // store.ready 还没翻转时 App.vue 渲染的就是这个节点。
  env.appEl.children.push({
    className: 'app-loading',
    textContent: '读取中',
    getBoundingClientRect: () => ({ width: 390, height: 844 }),
  });

  assert.equal(env.context.EdgeChatCompat.hasAppContent(), false, '加载态不是真实界面');
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

/**
 * 线上真实故障：@vitejs/plugin-legacy v8 把「浏览器是否支持 import.meta.resolve」
 * 当成新内核判据，在 index.html 内联 module 与现代包入口 chunk 顶部插入一段
 * 会主动 throw 的探针。该 API 只有 Chrome 105+ / Safari 16.4+ 才有，于是
 * iOS 12~16.3、Android WebView < 105、UC/QQ 内核一进页面就被打上
 * 「页面加载遇到问题」——点清缓存也没用，因为每次都会重新抛。
 */
test('构建工具的特性探测抛错不会被当成故障弹卡片', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: true });
  vm.runInContext(source, env.context);

  for (const fn of env.listeners.error || []) {
    fn({ message: 'Error: import.meta.resolve not supported' });
  }
  // 只跑到「错误上报」这一步：看门狗与 12 秒「加载较慢」提示不参与本用例。
  env.flushTimers(1000);

  assert.equal(env.bodyChildren.length, 0, '探测类抛错不能弹「页面加载遇到问题」');
  assert.match(String(env.context.__edgechatBoot.ignored), /import\.meta\.resolve/);
});

test('真实的启动错误仍然给出可操作提示', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: true });
  vm.runInContext(source, env.context);

  for (const fn of env.listeners.error || []) {
    fn({ message: 'Uncaught TypeError: window.foo is not a function' });
  }
  env.flushTimers(200);

  assert.equal(env.bodyChildren.length, 1);
  assert.match(JSON.stringify(env.bodyChildren[0]), /页面加载遇到问题/);
});

test('非致命提示在界面画出来后自动退场，不会永久盖住正常页面', async () => {
  const source = await readCompat();
  const env = createSandbox({ withSplash: true });
  vm.runInContext(source, env.context);

  for (const fn of env.listeners.error || []) fn({ message: 'Uncaught TypeError: boom' });
  env.flushTimers(200);
  assert.equal(env.bodyChildren.length, 1, '先要看到提示');

  // 备份包（或晚到的现代包）随后把界面渲染出来了。
  env.appEl.children.push({
    className: 'login-page',
    getBoundingClientRect: () => ({ width: 390, height: 844 })
  });
  env.flushTimers();

  assert.equal(env.bodyChildren.length, 0, '界面正常后提示必须退场');
});

