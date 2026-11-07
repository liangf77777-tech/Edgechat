import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const compatPath = fileURLToPath(new URL('../frontend/public/compat.js', import.meta.url));
const compatSource = await readFile(compatPath, 'utf8');

/**
 * 构造一个「老手机内核」沙箱：缺 Object.hasOwn / replaceAll /
 * MediaQueryList.addEventListener / visualViewport，localStorage 一访问就抛错。
 * 这正是线上复现出白屏的组合。
 */
function createLegacySandbox({ supportsModule = true, brokenStorage = true } = {}) {
  const timers = [];
  const listeners = {};
  const styleProps = {};
  const appEl = { innerHTML: '', appendChild() {} };
  const bodyEl = { children: [], appendChild(node) { this.children.push(node); return node; } };

  function makeElement(tag) {
    return {
      tagName: tag,
      children: [],
      style: { cssText: '' },
      setAttribute() {},
      appendChild(node) { this.children.push(node); return node; }
    };
  }

  const documentElement = {
    clientHeight: 844,
    style: {
      setProperty(key, value) { styleProps[key] = value; },
      removeProperty(key) { delete styleProps[key]; }
    }
  };

  const doc = {
    documentElement,
    body: bodyEl,
    hidden: false,
    getElementById(id) { return id === 'app' ? appEl : null; },
    createElement(tag) {
      const node = makeElement(tag);
      if (tag === 'script' && supportsModule) node.noModule = false;
      return node;
    },
    createTextNode(text) { return { text: String(text) }; }
  };

  function MediaQueryList() {
    this.matches = false;
    this.media = '';
    this._listener = null;
  }
  MediaQueryList.prototype.addListener = function (fn) { this._listener = fn; };
  MediaQueryList.prototype.removeListener = function () { this._listener = null; };
  // 故意不定义 addEventListener / removeEventListener。

  function Element() {}
  Element.prototype.nodeType = 1;
  function NodeList() {}
  NodeList.prototype.length = 0;

  const sandbox = {
    document: doc,
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    MediaQueryList,
    Element,
    NodeList,
    navigator: { userAgent: 'legacy-mobile', language: 'zh-CN' },
    location: { reload() { sandbox.__reloaded = true; } },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener() {},
    setTimeout(fn, delay) { timers.push({ fn, delay: delay || 0 }); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame(fn) { fn(0); return 1; },
    cancelAnimationFrame() {},
    console
  };
  sandbox.window = sandbox;

  if (brokenStorage) {
    Object.defineProperty(sandbox, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage disabled'); }
    });
    Object.defineProperty(sandbox, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage disabled'); }
    });
  } else {
    sandbox.localStorage = null;
    sandbox.sessionStorage = null;
  }

  const context = vm.createContext(sandbox);
  return {
    context,
    sandbox,
    appEl,
    bodyEl,
    styleProps,
    listeners,
    timers,
    flushTimers() {
      const pending = timers.splice(0, timers.length);
      for (const item of pending) item.fn();
      return pending.length;
    }
  };
}

function probe(context, expression) {
  return vm.runInContext(expression, context);
}

test('老内核缺失的内置 API 会被补齐，模块顶层不再抛错', () => {
  const env = createLegacySandbox();
  vm.runInContext(compatSource, env.context);

  const result = probe(env.context, `({
    hasOwn: typeof Object.hasOwn,
    hasOwnWorks: Object.hasOwn({ a: 1 }, 'a') === true && Object.hasOwn({ a: 1 }, 'b') === false,
    replaceAll: typeof String.prototype.replaceAll,
    replaceAllWorks: 'zh_TW'.replaceAll('_', '-') === 'zh-TW',
    arrayAt: typeof Array.prototype.at,
    mqlAdd: typeof MediaQueryList.prototype.addEventListener,
    mqlRemove: typeof MediaQueryList.prototype.removeEventListener,
    mqlForwards: (function () {
      var q = new MediaQueryList();
      var seen = 0;
      q.addEventListener('change', function () { seen += 1; });
      if (q._listener) q._listener();
      q.removeEventListener('change', function () {});
      return seen === 1 && q._listener === null;
    })(),
    elementClosest: typeof Element.prototype.closest,
    viewportHeight: document.documentElement.style.getPropertyValue
      ? null
      : null
  })`);

  assert.equal(result.hasOwn, 'function');
  assert.equal(result.hasOwnWorks, true);
  assert.equal(result.replaceAll, 'function');
  assert.equal(result.replaceAllWorks, true);
  assert.equal(result.arrayAt, 'function');
  assert.equal(result.mqlAdd, 'function');
  assert.equal(result.mqlRemove, 'function');
  assert.equal(result.mqlForwards, true);
  assert.equal(result.elementClosest, 'function');

  // 视口变量在挂载前就有值，聊天页不会高度塌陷。
  assert.equal(env.styleProps['--chat-viewport-height'], '844px');
  assert.equal(env.styleProps['--chat-viewport-offset-top'], '0px');
});

test('禁用存储的浏览器会被替换成可用的内存存储', () => {
  const env = createLegacySandbox();
  vm.runInContext(compatSource, env.context);

  const result = probe(env.context, `(function () {
    try {
      localStorage.setItem('edgechat.locale', 'zh-CN');
      var value = localStorage.getItem('edgechat.locale');
      localStorage.removeItem('edgechat.locale');
      return { ok: true, value: value, afterRemove: localStorage.getItem('edgechat.locale') };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  })()`);

  assert.equal(result.ok, true, '访问 localStorage 不应再抛错');
  assert.equal(result.value, 'zh-CN');
  assert.equal(result.afterRemove, null);
});

test('启动期异常会渲染可见错误卡片，而不是留下白屏', () => {
  const env = createLegacySandbox();
  vm.runInContext(compatSource, env.context);

  assert.equal(env.bodyEl.children.length, 0);
  for (const fn of env.listeners.error || []) {
    fn({ message: 'Object.hasOwn is not a function' });
  }
  env.flushTimers();

  assert.equal(env.bodyEl.children.length, 1, '应插入兜底提示节点');
  const notice = env.bodyEl.children[0];
  const texts = JSON.stringify(notice);
  assert.match(texts, /页面加载遇到问题/);
  assert.match(texts, /Object\.hasOwn is not a function/);
  assert.match(texts, /重新加载/);

  // 应用挂载成功后，兜底提示不能覆盖真实界面。
  env.appEl.innerHTML = '<div>chat</div>';
  const second = createLegacySandbox();
  vm.runInContext(compatSource, second.context);
  second.appEl.innerHTML = '<div>chat</div>';
  for (const fn of second.listeners.error || []) fn({ message: 'late error' });
  second.flushTimers();
  assert.equal(second.bodyEl.children.length, 0, '已挂载成功时不应再插入提示');
});

test('完全不支持 ES Module 的内核会看到明确说明', () => {
  const env = createLegacySandbox({ supportsModule: false });
  vm.runInContext(compatSource, env.context);
  env.flushTimers();

  assert.equal(env.bodyEl.children.length, 1);
  assert.match(JSON.stringify(env.bodyEl.children[0]), /浏览器版本过旧/);
  assert.match(JSON.stringify(env.bodyEl.children[0]), /在浏览器中打开/);
});

test('兼容层可重复执行且不会破坏现代浏览器已有的 API', () => {
  const env = createLegacySandbox({ brokenStorage: false });
  env.sandbox.localStorage = {
    _data: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; }
  };
  env.sandbox.sessionStorage = env.sandbox.localStorage;
  const context = vm.createContext(env.sandbox);

  vm.runInContext(compatSource, context);
  vm.runInContext(compatSource, context);

  assert.equal(probe(context, "typeof Object.hasOwn"), 'function');
  assert.equal(probe(context, "'a_b'.replaceAll('_', '-')"), 'a-b');
  assert.equal(probe(context, "localStorage.setItem('x','1') || localStorage.getItem('x')"), '1');
  assert.equal(probe(context, "window.__edgechatCompatInstalled"), true);
});
