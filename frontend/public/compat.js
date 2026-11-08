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
      // 极老 WebKit 连带前缀的 matchesSelector 都没有；退化成 querySelectorAll
      // 比对，保证 matches 一定存在，后面的 closest 才有实现基础。
      if (!vendorMatches) {
        vendorMatches = function (selector) {
          try {
            var owner = this.ownerDocument || doc;
            var nodes = owner.querySelectorAll(selector);
            for (var i = 0; i < nodes.length; i += 1) {
              if (nodes[i] === this) return true;
            }
          } catch (e) {}
          return false;
        };
      }
      define(ElementCtor.prototype, 'matches', vendorMatches);
    }
    if (!ElementCtor.prototype.closest) {
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

  win.__edgechatBoot = {
    at: new Date().getTime(),
    compat: '2026-11-08a',
    mounted: false,
    painted: false,
    note: 'boot-trace'
  };

  // 构建工具「故意抛错」做特性探测时产生的错误，不是故障。
  //
  // 最典型的是 @vitejs/plugin-legacy v8：它把「浏览器是否支持
  // import.meta.resolve」当成新内核判据，并在 index.html 的内联 module 与
  // 现代包入口 chunk 顶部插入
  //   import'data:text/javascript,if(!import.meta.resolve)throw Error(
  //     "import.meta.resolve not supported")'
  // 而该 API 只有 Chrome 105+ / Safari 16.4+ 才有 —— iOS 12~16.3 的 Safari、
  // Android WebView < 105、UC/QQ 内核一进页面就抛，于是「现代包整段求值失败 +
  // 兼容层弹出页面加载遇到问题」，用户彻底打不开。
  //
  // 构建侧已经在 frontend/legacy-guard-probe.js 里把探针从产物中删掉了；这里
  // 再兜一层，是为了覆盖「手机上还缓存着上一版 index.html / chunk」的情况：
  // 旧文件照样会抛，但绝不能因此把已经能正常渲染的界面盖住。
  var BENIGN_BOOT_ERRORS = [
    /import\.meta\.resolve/i,
    /vite:\s*loading legacy chunks/i
  ];

  function isBenignBootError(message) {
    var text = String(message || '');
    if (!text) return false;
    for (var b = 0; b < BENIGN_BOOT_ERRORS.length; b += 1) {
      if (BENIGN_BOOT_ERRORS[b].test(text)) return true;
    }
    return false;
  }

  function rememberError(message) {
    try {
      var boot = win.__edgechatBoot;
      if (!boot) return;
      boot.errors = boot.errors || [];
      if (message && boot.errors.length < 6) boot.errors.push(message);
    } catch (e) {}
  }

  // 界面是否真的画出来了。
  //
  // 两条判据都不能用错，历史上各踩过一次：
  //   1. 不能量 #app 自身的盒子。聊天页根节点 .chat-layout 是 position:fixed，
  //      完全脱离文档流，不会撑开 #app —— #app 高度恒为 0。按 #app 自身尺寸
  //      判断会在「界面明明正常」时误报白屏（已实测复现）。
  //   2. 不能用 innerHTML 是否为空判断。路由还没解析出来时 <router-view> 只渲染
  //      一个注释占位（<!---->），innerHTML 非空而屏幕上什么都没有；过去的兜底
  //      分支正是踩了这个坑，把白屏判成「已渲染」，看门狗全程沉默 —— 用户看到
  //      的就是「加载中闪一下，然后永久白屏且没有任何提示」。
  // 所以只认两样东西：有可见面积的元素子节点，或真实文字（textContent 不含注释）。
  function hasAppContent() {
    var app = doc && doc.getElementById && doc.getElementById('app');
    if (!app) return false;
    var kids = app.children;
    var i;
    var realChildren = 0;
    if (kids && kids.length) {
      for (i = 0; i < kids.length; i += 1) {
        var el = kids[i];
        if (!el) continue;
        // 「读取中」是 App.vue 自己的加载态，不是真实界面：它出现说明会话还没
        // 恢复完，此时撤掉首屏占位只会「闪一下再白屏」，所以不计入内容。
        if ((' ' + String(el.className || '') + ' ').indexOf(' app-loading ') > -1) continue;
        realChildren += 1;
        if (!isFn(el.getBoundingClientRect)) return true;
        var rect = el.getBoundingClientRect();
        if (rect && rect.width >= 24 && rect.height >= 24) return true;
        if (String(el.textContent || '').replace(/\s+/g, '').length > 0) return true;
      }
      // 有元素子节点但全都是加载态 → 还没画出真界面。
      if (realChildren === 0) return false;
    }
    var text = String(app.textContent || '').replace(/\s+/g, '');
    return text.length > 0;
  }

  /* ------------------------------------------------------------------ *
   * 8. 首屏占位控制
   *    #boot-splash 位于 #app 之外，Vue 挂载不会带走它；只有确认界面真的
   *    画出内容后才移除。这样即使路由永远解析不出来，用户看到的也是
   *    「加载中…」+ 可操作提示，而不是纯白。
   * ------------------------------------------------------------------ */
  var splashRemoved = false;
  var splashNode = null;

  function getSplash() {
    if (splashNode && splashNode.parentNode) return splashNode;
    splashNode = doc && doc.getElementById ? doc.getElementById('boot-splash') : null;
    return splashNode;
  }

  function removeSplash() {
    if (splashRemoved) return;
    splashRemoved = true;
    var node = getSplash();
    if (!node) return;
    try {
      if (node.style) {
        node.style.transition = 'opacity 140ms linear';
        node.style.opacity = '0';
      }
    } catch (e) {}
    var drop = function () {
      try {
        if (node.parentNode) node.parentNode.removeChild(node);
      } catch (e) {}
    };
    try { win.setTimeout(drop, 160); } catch (e) { drop(); }
  }

  function paintConfirmed() {
    if (!hasAppContent()) return false;
    win.__edgechatBoot.painted = true;
    removeSplash();
    return true;
  }

  // 挂载后内容出现的那一刻就撤掉占位：MutationObserver 立即响应，
  // 再加一路 250ms 轮询兜底（极老内核 / 无 MutationObserver 的 WebView）。
  (function watchPaint() {
    if (splashRemoved) return;
    if (paintConfirmed()) return;
    var appNode = doc && doc.getElementById ? doc.getElementById('app') : null;
    if (appNode && isFn(win.MutationObserver)) {
      try {
        var observer = new win.MutationObserver(function () {
          if (paintConfirmed()) observer.disconnect();
        });
        observer.observe(appNode, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    }
    var ticks = 0;
    var poll = function () {
      if (splashRemoved) return;
      ticks += 1;
      if (paintConfirmed()) return;
      // 最长盯 40 秒，之后完全交给下面的看门狗，避免无谓的定时器。
      if (ticks > 160) return;
      win.setTimeout(poll, 250);
    };
    win.setTimeout(poll, 250);
  })();

  // 清掉 Service Worker 与 Cache Storage 再重载：这一招同时解决
  // 「旧 SW 拦截导航」「HTML 缓存指向已删除的旧 hash 资源」两类白屏。
  function hardReload() {
    var href = win.location.href.split('#')[0];
    href += (href.indexOf('?') === -1 ? '?' : '&') + '_r=' + new Date().getTime();
    var doReload = function () { win.location.replace(href); };
    var pending = 0;
    var done = function () {
      pending -= 1;
      if (pending <= 0) doReload();
    };

    try {
      if (win.navigator && win.navigator.serviceWorker &&
          isFn(win.navigator.serviceWorker.getRegistrations)) {
        pending += 1;
        win.navigator.serviceWorker.getRegistrations().then(function (list) {
          for (var i = 0; i < list.length; i += 1) {
            try { list[i].unregister(); } catch (e) {}
          }
          done();
        })['catch'](done);
      }
      if (win.caches && isFn(win.caches.keys)) {
        pending += 1;
        win.caches.keys().then(function (keys) {
          for (var i = 0; i < keys.length; i += 1) {
            try { win.caches['delete'](keys[i]); } catch (e) {}
          }
          done();
        })['catch'](done);
      }
    } catch (e) {}

    if (pending <= 0) {
      doReload();
      return;
    }
    // 兜底：异步清理卡住时也要让用户能重载。
    win.setTimeout(doReload, 1500);
  }

  function buildDiagnostics() {
    var nav = win.navigator || {};
    var boot = win.__edgechatBoot || {};
    var appNode = doc && doc.getElementById ? doc.getElementById('app') : null;
    var kids = appNode && appNode.children ? appNode.children.length : -1;
    return [
      'href=' + (win.location && win.location.href ? win.location.href : ''),
      'ua=' + (nav.userAgent || ''),
      'compat=' + (boot.compat || '') + ' mounted=' + boot.mounted + ' painted=' + boot.painted,
      'route=' + (boot.route || '') + ' kids=' + kids,
      'errors=' + ((boot.errors && boot.errors.length ? boot.errors.join(' || ') : 'none'))
    ].join('\n');
  }

  // 手机端排查只能靠用户把现场带回来：一键复制设备与启动轨迹。
  function copyDiagnostics() {
    var text = buildDiagnostics();
    var nav = win.navigator || {};
    try {
      if (nav.clipboard && isFn(nav.clipboard.writeText)) {
        nav.clipboard.writeText(text);
        return;
      }
    } catch (e) {}
    try {
      var area = doc.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:-9999px;top:0';
      doc.body.appendChild(area);
      if (isFn(area.select)) area.select();
      if (isFn(doc.execCommand)) doc.execCommand('copy');
      doc.body.removeChild(area);
    } catch (e) {}
  }

  function createActionButton(text, handler, primary) {
    var button = doc.createElement('button');
    button.type = 'button';
    button.appendChild(doc.createTextNode(text));
    button.style.cssText = [
      'display:inline-block', 'padding:10px 20px', 'min-height:44px',
      'margin:0 10px 10px 0', 'border:0', 'border-radius:10px',
      primary ? 'background:#0f766e' : 'background:#e3e8ee',
      primary ? 'color:#fff' : 'color:#1f2933',
      'font-size:16px', 'cursor:pointer'
    ].join(';');
    button.onclick = handler;
    return button;
  }

  // 非致命提示（脚本里一条迟到的、可自愈的错误）在界面真正画出来后自行退场。
  // 它带着 z-index:2147483647 铺满全屏，只要留在 DOM 里就会永久盖住本来正常的
  // 页面 —— 上一版正是这样：iOS 16.3 及以下抛一条特性探测错误、卡片弹出，
  // 即便备份包后来渲染成功，用户也只看得到这张卡片。
  function watchNoticeRecovery(box) {
    var ticks = 0;
    var recheck = function () {
      if (!box || !box.parentNode) return;
      if (hasAppContent()) {
        try {
          box.parentNode.removeChild(box);
        } catch (e) {}
        noticeShown = false;
        return;
      }
      ticks += 1;
      if (ticks < 80) win.setTimeout(recheck, 500);
    };
    win.setTimeout(recheck, 600);
  }

  function showBootNotice(title, detail, options) {
    if (noticeShown || !doc) return;
    var opts = options || {};
    // 已经挂载成功就不要覆盖真实界面；除非调用方明确要求强制提示。
    if (!opts.force && hasAppContent()) return;
    noticeShown = true;
    // 提示卡片自己要占据首屏，占位留着会互相遮挡。
    removeSplash();

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

    var actions = doc.createElement('div');
    actions.appendChild(createActionButton('清除缓存并重新加载', hardReload, true));
    actions.appendChild(createActionButton('重新加载', function () {
      win.location.reload();
    }, false));
    actions.appendChild(createActionButton('复制诊断信息', copyDiagnostics, false));

    var hint = doc.createElement('p');
    hint.style.cssText = 'margin:14px 0 0;font-size:12px;line-height:1.6;color:#7b8794;word-break:break-all';
    hint.appendChild(doc.createTextNode(buildDiagnostics()));

    card.appendChild(heading);
    card.appendChild(body);
    card.appendChild(actions);
    card.appendChild(hint);
    box.appendChild(card);
    if (doc.body) doc.body.appendChild(box);
    else if (doc.documentElement) doc.documentElement.appendChild(box);
    if (!opts.force) watchNoticeRecovery(box);
  }

  function onBootError(event) {
    var message = '';
    if (event && event.message) message = String(event.message);
    else if (event && event.reason) message = String(event.reason && event.reason.message || event.reason);
    rememberError(message);
    // 特性探测类的「故意抛错」只记录，不弹卡片：此时界面往往完全正常。
    if (isBenignBootError(message)) {
      try {
        win.__edgechatBoot.ignored = win.__edgechatBoot.ignored || [];
        if (win.__edgechatBoot.ignored.length < 6) win.__edgechatBoot.ignored.push(message);
      } catch (e) {}
      return;
    }
    win.setTimeout(function () {
      // 这里不加 force：已经成功挂载的界面不应该被一条迟到的错误盖住。
      showBootNotice(
        '页面加载遇到问题',
        (message ? '错误信息：' + message + '。' : '') +
        '请检查网络后点击「清除缓存并重新加载」。若仍然无法打开，可尝试切换为系统浏览器或更新微信/浏览器版本。'
      );
    }, 120);
  }

  // 供 main.js 的 Vue errorHandler 调用：Vue 内部错误不会触发 window error 事件，
  // 过去它们只会让界面静默变空。
  function reportFatal(message, force) {
    rememberError(message);
    // 业务层也可能把探测类错误当成渲染失败转上来，同样不该弹卡片。
    if (isBenignBootError(message)) return;
    showBootNotice(
      '界面渲染失败',
      (message ? '错误信息：' + message + '。' : '') +
      '可以点击「清除缓存并重新加载」修复；若反复出现，请按「复制诊断信息」把下面这段反馈给管理员。',
      { force: force !== false }
    );
  }

  // 暴露给业务代码复用（useChatViewport 会读取）。
  define(win, 'EdgeChatCompat', {
    syncViewportVars: syncViewportVars,
    reportFatal: reportFatal,
    hardReload: hardReload,
    hasAppContent: hasAppContent,
    hasMediaQueryListeners: !!(MQL && MQL.prototype && isFn(MQL.prototype.addEventListener))
  });

  if (isFn(win.addEventListener)) {
    win.addEventListener('error', onBootError, false);
    win.addEventListener('unhandledrejection', onBootError, false);
  }

  // 完全不支持 ES Module 的内核（Chrome < 61 / iOS < 11）过去只会执行到这一段。
  // 若构建产物里带了 legacy（nomodule）备份包，它们仍能跑起来，因此这里不立刻
  // 报错，而是交给下面的看门狗：确实什么都没渲染出来时再提示升级。
  var supportsModule = doc && doc.createElement
    ? 'noModule' in doc.createElement('script')
    : true;

  // 看门狗：脚本跑完但界面始终没出现（白屏）时给出可操作的出口。
  // 6.5 秒足够覆盖弱网首屏；此时静态占位已被 Vue 替换却仍然没有内容，
  // 说明渲染链路真的断了，而不是还在加载。
  var watchdogShown = false;
  function watchdogCheck() {
    if (noticeShown || watchdogShown) return;
    if (hasAppContent()) return;
    // 静态占位还在，说明还在等资源/等路由，交给下面的「加载较慢」提示。
    if (doc && doc.getElementById && doc.getElementById('boot-splash')) return;
    watchdogShown = true;
    if (!supportsModule) {
      showBootNotice(
        '浏览器版本过旧',
        '当前浏览器内核无法运行这个网页应用。请更新系统浏览器，' +
        '或在微信中点击右上角「···」选择「在浏览器中打开」。',
        { force: true }
      );
      return;
    }
    showBootNotice(
      '界面没有显示出来',
      '页面脚本已经执行，但界面未能渲染。常见原因是浏览器缓存了旧版本资源，' +
      '或网络中断。请点击「清除缓存并重新加载」；若仍无效，' +
      '请换用系统浏览器（微信中点击右上角「···」→「在浏览器中打开」）。',
      { force: true }
    );
  }

  win.setTimeout(watchdogCheck, 6500);

  // 12 秒仍在加载：区分「慢」与「内核算不动」。
  win.setTimeout(function () {
    if (noticeShown || hasAppContent()) return;
    if (doc && doc.getElementById && doc.getElementById('boot-splash')) {
      showBootNotice(
        '加载较慢',
        '页面资源还没有加载完成。请检查网络后点击「清除缓存并重新加载」，或稍后再试。',
        { force: true }
      );
      return;
    }
    watchdogCheck();
  }, 12000);
})(typeof window !== 'undefined' ? window : this);
