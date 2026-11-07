/*
 * EdgeChat 浏览器兼容引导层。
 *
 * 这是纯 ES5 的「经典脚本」，由 index.html 在 <script type="module"> 之前同步加载。
 * 放在 public/ 下而不是 src/ 里，是为了保证它绝不参与打包、绝不会被拆成异步
 * chunk、绝不依赖 ESM —— 老旧手机内核即使完全不支持 ES Module 也能先跑完这一段。
 *
 * 解决的问题（均已在真实浏览器里复现过白屏）：
 *   1. i18n.js 模块顶层调用 Object.hasOwn()；老内核抛 TypeError 导致整个 bundle
 *      加载中断，Vue 从未挂载，页面纯白。
 *   2. visual-effects.ts / liquid-glass.ts 调用
 *      MediaQueryList.addEventListener('change')；iOS 13、微信 X5 老内核等只有
 *      addListener()，同样会在挂载前抛错。
 *   3. 部分国产浏览器/无痕模式下访问 localStorage 直接抛 SecurityError。
 *   4. 聊天页依赖 --chat-viewport-height；挂载前没有值时，100dvh 在旧内核里
 *      解析失败，容器高度塌陷成 0。
 *   5. 任何其它启动期异常过去都表现为「白屏无提示」，现在改为可见的错误卡片。
 */
(function (global) {
  'use strict';

  var win = global || (typeof window !== 'undefined' ? window : null);
  if (!win) return;
  if (win.__edgechatCompatInstalled) return;
  win.__edgechatCompatInstalled = true;

  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var doc = win.document;

  function define(target, name, value) {
    if (!target) return;
    try {
      Object.defineProperty(target, name, {
        value: value,
        configurable: true,
        writable: true
      });
    } catch (e) {
      try { target[name] = value; } catch (ignored) {}
    }
  }

  function isFn(value) {
    return typeof value === 'function';
  }

  /* ------------------------------------------------------------------ *
   * 1. globalThis —— iOS 12.2 / Chrome 70 以下缺失，Vite 产物会用到
   * ------------------------------------------------------------------ */
  if (typeof win.globalThis === 'undefined') {
    define(win, 'globalThis', win);
  }

  /* ------------------------------------------------------------------ *
   * 2. 模块顶层会直接调用的内置 API
   * ------------------------------------------------------------------ */
  if (!isFn(Object.hasOwn)) {
    define(Object, 'hasOwn', function (object, key) {
      return object != null && hasOwnProperty.call(Object(object), key);
    });
  }

  if (!isFn(String.prototype.replaceAll)) {
    define(String.prototype, 'replaceAll', function (search, replacement) {
      var subject = String(this);
      if (search instanceof RegExp) {
        if (!search.global) {
          throw new TypeError('replaceAll must be called with a global RegExp');
        }
        return subject.replace(search, replacement);
      }
      return subject.split(String(search)).join(String(replacement));
    });
  }

  if (!isFn(Array.prototype.at)) {
    define(Array.prototype, 'at', function (index) {
      var length = this.length >>> 0;
      var position = Math.trunc ? Math.trunc(Number(index)) : Number(index) | 0;
      if (position < 0) position += length;
      return position < 0 || position >= length ? undefined : this[position];
    });
  }

  if (!isFn(String.prototype.trimStart)) {
    define(String.prototype, 'trimStart', function () {
      return String(this).replace(/^\s+/, '');
    });
  }
  if (!isFn(String.prototype.trimEnd)) {
    define(String.prototype, 'trimEnd', function () {
      return String(this).replace(/\s+$/, '');
    });
  }

  if (!isFn(Array.prototype.flat)) {
    define(Array.prototype, 'flat', function (depth) {
      var limit = depth === undefined ? 1 : Number(depth) | 0;
      var result = [];
      var i;
      for (i = 0; i < this.length; i += 1) {
        if (Array.isArray(this[i]) && limit > 0) {
          result = result.concat(this[i].flat(limit - 1));
        } else if (this[i] !== undefined) {
          result.push(this[i]);
        }
      }
      return result;
    });
  }

  if (!isFn(Object.fromEntries)) {
    define(Object, 'fromEntries', function (entries) {
      var result = {};
      var list = Array.from ? Array.from(entries) : [].slice.call(entries);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i]) result[list[i][0]] = list[i][1];
      }
      return result;
    });
  }

  if (!isFn(Promise.prototype.finally) && win.Promise) {
    define(Promise.prototype, 'finally', function (callback) {
      var constructor = this.constructor;
      return this.then(
        function (value) {
          return constructor.resolve(callback && callback()).then(function () { return value; });
        },
        function (reason) {
          return constructor.resolve(callback && callback()).then(function () { throw reason; });
        }
      );
    });
  }

  /* ------------------------------------------------------------------ *
   * 3. DOM 便捷 API —— 老 Android WebView / iOS 11 缺失
   * ------------------------------------------------------------------ */
  var ElementCtor = win.Element;
  if (ElementCtor && ElementCtor.prototype) {
    if (!ElementCtor.prototype.matches) {
      var vendorMatches = ElementCtor.prototype.msMatchesSelector ||
        ElementCtor.prototype.webkitMatchesSelector ||
        ElementCtor.prototype.mozMatchesSelector;
      if (vendorMatches) define(ElementCtor.prototype, 'matches', vendorMatches);
    }
    if (!ElementCtor.prototype.closest && ElementCtor.prototype.matches) {
      define(ElementCtor.prototype, 'closest', function (selector) {
        var node = this;
        while (node && node.nodeType === 1) {
          if (node.matches(selector)) return node;
          node = node.parentElement || node.parentNode;
        }
        return null;
      });
    }
  }

  if (win.NodeList && win.NodeList.prototype && !win.NodeList.prototype.forEach) {
    define(win.NodeList.prototype, 'forEach', function (callback, thisArg) {
      for (var i = 0; i < this.length; i += 1) callback.call(thisArg, this[i], i, this);
    });
  }

  if (!win.requestAnimationFrame) {
    define(win, 'requestAnimationFrame', function (callback) {
      return win.setTimeout(function () { callback(Date.now()); }, 16);
    });
    define(win, 'cancelAnimationFrame', function (id) { win.clearTimeout(id); });
  }

  if (!isFn(win.queueMicrotask)) {
    define(win, 'queueMicrotask', function (callback) {
      if (win.Promise) win.Promise.resolve().then(callback);
      else win.setTimeout(callback, 0);
    });
  }

  if (!isFn(win.matchMedia)) {
    define(win, 'matchMedia', function () {
      return {
        media: '',
        matches: false,
        addListener: function () {},
        removeListener: function () {},
        addEventListener: function () {},
        removeEventListener: function () {}
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. MediaQueryList.addEventListener —— iOS 13 / 微信 X5 老内核
   *    只有废弃的 addListener。这里是挂载前的同步抛错点，必须补齐。
   * ------------------------------------------------------------------ */
  var MQL = win.MediaQueryList;
  if (MQL && MQL.prototype) {
    if (!isFn(MQL.prototype.addEventListener)) {
      define(MQL.prototype, 'addEventListener', function (type, listener) {
        if (type === 'change' && isFn(this.addListener)) this.addListener(listener);
      });
    }
    if (!isFn(MQL.prototype.removeEventListener)) {
      define(MQL.prototype, 'removeEventListener', function (type, listener) {
        if (type === 'change' && isFn(this.removeListener)) this.removeListener(listener);
      });
    }
    // 极老内核连 addListener 都没有时，补成安全的空实现。
    if (!isFn(MQL.prototype.addListener)) {
      define(MQL.prototype, 'addListener', function () {});
      define(MQL.prototype, 'removeListener', function () {});
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. 存储兜底 —— 无痕模式 / 禁用 DOM storage / 部分国产浏览器
   *    直接访问 window.localStorage 就可能抛 SecurityError，因此检测到不可用
   *    时把属性替换成内存实现，让所有现存的 localStorage 调用保持原样可用。
   * ------------------------------------------------------------------ */
  function createMemoryStorage() {
    var data = {};
    return {
      getItem: function (key) {
        var name = String(key);
        return hasOwnProperty.call(data, name) ? data[name] : null;
      },
      setItem: function (key, value) { data[String(key)] = String(value); },
      removeItem: function (key) { delete data[String(key)]; },
      clear: function () { data = {}; },
      key: function (index) {
        var keys = Object.keys(data);
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
      get length() { return Object.keys(data).length; }
    };
  }

  function storageUsable(storage) {
    try {
      var probe = '__edgechat_storage_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  var storageNames = ['localStorage', 'sessionStorage'];
  for (var s = 0; s < storageNames.length; s += 1) {
    (function (name) {
      var usable = false;
      try { usable = win[name] && storageUsable(win[name]); } catch (e) { usable = false; }
      if (!usable) define(win, name, createMemoryStorage());
    })(storageNames[s]);
  }

  /* ------------------------------------------------------------------ *
   * 6. 视口高度 —— 保证聊天页首帧就有 --chat-viewport-height，
   *    不再依赖 100dvh（iOS 15.4 以下 / Chrome 108 以下不认识）。
   * ------------------------------------------------------------------ */
  function syncViewportVars() {
    if (!doc || !doc.documentElement || !doc.documentElement.style) return;
    var root = doc.documentElement;
    if (!isFn(root.style.setProperty)) return;
    var visual = win.visualViewport;
    var height = (visual && visual.height) || win.innerHeight || root.clientHeight || 0;
    var offsetTop = (visual && visual.offsetTop) || 0;
    if (height > 0) root.style.setProperty('--chat-viewport-height', Math.round(height) + 'px');
    root.style.setProperty('--chat-viewport-offset-top', Math.round(offsetTop) + 'px');
  }

  syncViewportVars();
  if (isFn(win.addEventListener)) {
    win.addEventListener('resize', syncViewportVars, false);
    win.addEventListener('orientationchange', syncViewportVars, false);
    win.addEventListener('pageshow', syncViewportVars, false);
  }
  if (win.visualViewport && isFn(win.visualViewport.addEventListener)) {
    win.visualViewport.addEventListener('resize', syncViewportVars, false);
    win.visualViewport.addEventListener('scroll', syncViewportVars, false);
  }

  // 暴露给业务代码复用（useChatViewport 会读取）。
  define(win, 'EdgeChatCompat', {
    syncViewportVars: syncViewportVars,
    hasMediaQueryListeners: !!(MQL && MQL.prototype && isFn(MQL.prototype.addEventListener))
  });

  /* ------------------------------------------------------------------ *
   * 7. 启动兜底 —— 任何启动期异常都要给出可见反馈，绝不留白屏
   * ------------------------------------------------------------------ */
  var noticeShown = false;

  function showBootNotice(title, detail) {
    if (noticeShown || !doc) return;
    var app = doc.getElementById && doc.getElementById('app');
    // 已经挂载成功就不要覆盖真实界面。
    if (!app || (app.innerHTML && app.innerHTML.length > 0)) return;
    noticeShown = true;

    var box = doc.createElement('div');
    box.setAttribute('role', 'alert');
    box.setAttribute('data-edgechat-boot-notice', '1');
    box.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'display:block', 'padding:24px', 'box-sizing:border-box', 'overflow:auto',
      'background:#f7f9fb', 'color:#1f2933', 'font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
      '-webkit-text-size-adjust:100%'
    ].join(';');

    var card = doc.createElement('div');
    card.style.cssText = [
      'max-width:520px', 'margin:12vh auto 0', 'padding:24px', 'box-sizing:border-box',
      'background:#fff', 'border:1px solid #e3e8ee', 'border-radius:16px',
      'box-shadow:0 8px 30px rgba(15,35,55,.08)'
    ].join(';');

    var heading = doc.createElement('h1');
    heading.style.cssText = 'margin:0 0 12px;font-size:19px;line-height:1.4;color:#12313c';
    heading.appendChild(doc.createTextNode(title));

    var body = doc.createElement('p');
    body.style.cssText = 'margin:0 0 18px;font-size:15px;color:#52606d;word-break:break-word';
    body.appendChild(doc.createTextNode(detail));

    var button = doc.createElement('button');
    button.type = 'button';
    button.appendChild(doc.createTextNode('重新加载'));
    button.style.cssText = [
      'display:inline-block', 'padding:10px 20px', 'min-height:44px',
      'border:0', 'border-radius:10px', 'background:#0f766e', 'color:#fff',
      'font-size:16px', 'cursor:pointer'
    ].join(';');
    button.onclick = function () { win.location.reload(); };

    card.appendChild(heading);
    card.appendChild(body);
    card.appendChild(button);
    box.appendChild(card);
    if (doc.body) doc.body.appendChild(box);
    else if (doc.documentElement) doc.documentElement.appendChild(box);
  }

  function onBootError(event) {
    var message = '';
    if (event && event.message) message = String(event.message);
    else if (event && event.reason) message = String(event.reason && event.reason.message || event.reason);
    win.setTimeout(function () {
      showBootNotice(
        '页面加载遇到问题',
        (message ? '错误信息：' + message + '。' : '') +
        '请检查网络后点击「重新加载」。若仍然无法打开，可尝试切换为系统浏览器或更新微信/浏览器版本。'
      );
    }, 120);
  }

  if (isFn(win.addEventListener)) {
    win.addEventListener('error', onBootError, false);
    win.addEventListener('unhandledrejection', onBootError, false);
  }

  // 完全不支持 ES Module 的内核（Chrome < 61 / iOS < 11）不会执行任何打包脚本。
  // 至少给出明确说明，而不是一片空白。
  var supportsModule = doc && doc.createElement
    ? 'noModule' in doc.createElement('script')
    : true;
  if (!supportsModule) {
    win.setTimeout(function () {
      showBootNotice(
        '浏览器版本过旧',
        '当前浏览器内核不支持现代网页应用所需的模块脚本。请更新系统浏览器，或在微信中点击右上角「···」选择「在浏览器中打开」。'
      );
    }, 0);
  } else {
    // 网络慢或 CDN 抖动时，8 秒后仍没挂载就给出提示（不会覆盖已挂载成功的界面）。
    win.setTimeout(function () {
      var app = doc && doc.getElementById && doc.getElementById('app');
      if (app && (!app.innerHTML || app.innerHTML.length === 0)) {
        showBootNotice(
          '加载较慢',
          '页面资源还没有加载完成。请检查网络后点击「重新加载」，或稍后再试。'
        );
      }
    }, 8000);
  }
})(typeof window !== 'undefined' ? window : this);
