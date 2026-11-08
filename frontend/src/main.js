import { createApp } from 'vue';
import { Capacitor } from '@capacitor/core';
import App from './App.vue';
import router from './router.js';
import store from './store.js';
import {
  installCapacitorIntegration,
  queueNativeRoomTarget
} from './capacitor-platform.ts';
import './styles/base.css';
import './styles.css';
import './styles-liquid.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/ui.css';
import './styles/color-themes.css';
import './styles/visual-effects.css';
import './styles/mobile.css';
import { initLiquidGlass } from './liquid-glass.ts';
import { initVisualEffects } from './visual-effects.ts';
import { initializeI18n } from './i18n.js';
import { parseNotificationRoomTarget, takeNotificationRoomTarget } from './notification-target.js';
import { installChunkLoadRecovery } from './chunk-load.ts';

// index.html 里的 public/compat.js 已经在本模块之前同步跑完，负责补齐老内核缺失的
// 内置 API、视口变量与启动兜底。这里遵循「渐进增强」：任何非核心初始化失败都只
// 记录警告，绝不能阻止 #app 挂载 —— 过去这正是手机端整页空白的主要原因。
function safeRun(label, fn) {
  try {
    return fn();
  } catch (error) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[edgechat] ' + label + ' 初始化失败，已跳过：', error);
    }
    return undefined;
  }
}

const noop = () => {};

installChunkLoadRecovery(window);
// 挂载页面前应用偏好，避免低特效用户先看到一帧完整玻璃效果。
const disposeVisualEffects = safeRun('visual-effects', initVisualEffects) || noop;

// 点击通知后新打开的窗口从 URL 恢复会话；登录后聊天页也能消费这个目标。
const isCapacitorNative = safeRun('capacitor-detect', () => Capacitor.isNativePlatform()) || false;
const initialNotificationTarget = isCapacitorNative
  ? null
  : safeRun('notification-target', () => takeNotificationRoomTarget(window));
if (initialNotificationTarget) safeRun('queue-room', () => queueNativeRoomTarget(initialNotificationTarget));

// 注册 Service Worker，使 Chrome/Edge 满足 PWA 可安装条件（地址栏安装按钮）。
// 仅在浏览器支持且非 Capacitor 原生环境下注册。
if ('serviceWorker' in navigator && !isCapacitorNative) {
  safeRun('service-worker', () => {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // 注册失败不影响应用功能，忽略即可。
      });
    });

    // 系统通知（Service Worker 弹出）被点击时，打开对应会话。
    if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const payload = event.data;
        if (!payload || payload.type !== 'edgechat:notification-click') return;
        const target = safeRun('parse-notification', () => parseNotificationRoomTarget(payload.data));
        if (!target) return;
        queueNativeRoomTarget(target);
        void router.push('/');
      });
    }
  });
}

// 应用自定义背景。部分手机浏览器/无痕模式禁止读取存储，容错处理。
safeRun('custom-background', () => {
  const customBg = localStorage.getItem('customBackground');
  if (customBg) document.body.style.background = customBg;
});

function currentPath() {
  const route = router && router.currentRoute ? router.currentRoute.value : null;
  return route && route.fullPath ? route.fullPath : '';
}

// 路由是否真的匹配到了组件。拿不到路由对象时返回 true —— 宁可少判断一次，
// 也不要在桩环境里把正常启动误报成故障。
function routeUnmatched() {
  const route = router && router.currentRoute ? router.currentRoute.value : null;
  if (!route) return false;
  return !route.matched || route.matched.length === 0;
}

// 界面是否真的画出来了。判定逻辑放在 compat.js 里：它要处理聊天页那种
// 「子节点 fixed、#app 高度为 0」的正常结构，本地再实现一份没有意义。
function appPainted() {
  const compat = window.EdgeChatCompat;
  if (!compat || typeof compat.hasAppContent !== 'function') return true;
  return compat.hasAppContent();
}

function bootReport(message) {
  safeRun('boot-report', () => {
    const compat = window.EdgeChatCompat;
    if (compat && typeof compat.reportFatal === 'function') compat.reportFatal(message, true);
  });
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error('[edgechat] 启动失败：', message);
  }
}

// 首屏自愈：手机端出现过「加载中闪一下然后永久白屏」——
// 路由没解析出来时 RouterView 只渲染注释，屏幕上什么都没有，而旧版兜底又把
// 注释当成「已渲染」，于是既空白又不提示。现在：
//   1. 占位由 compat.js 托管，确认真的画出内容才撤掉，中途不会留白；
//   2. 路由为空就退回登录页重试一次；
//   3. 仍然为空则给出可见、可复制的错误卡片。
function ensurePainted() {
  let retried = false;
  const timers = [];
  const stop = () => {
    while (timers.length) clearTimeout(timers.pop());
  };
  const check = (stage) => {
    if (appPainted()) {
      stop();
      return;
    }
    safeRun('boot-trace', () => {
      if (window.__edgechatBoot) window.__edgechatBoot.route = currentPath();
    });
    // 路由已经匹配，只是在等资源下载：属于正常加载，占位还盖着，不要打断。
    if (!routeUnmatched()) return;
    if (stage === 1 && !retried && currentPath() !== '/login') {
      retried = true;
      safeRun('route-fallback', () => {
        Promise.resolve(router.replace('/login')).catch(noop);
      });
      return;
    }
    if (stage >= 2) {
      stop();
      bootReport('路由未匹配，首屏 5 秒内没有可渲染内容（path=' + (currentPath() || '未知') + '）');
    }
  };
  timers.push(setTimeout(() => check(1), 2200));
  timers.push(setTimeout(() => check(2), 5200));
}

function reportRenderError(error, info) {
  const message = error && error.message ? error.message : String(error);
  safeRun('report-render-error', () => {
    const compat = window.EdgeChatCompat;
    if (compat && typeof compat.reportFatal === 'function') {
      compat.reportFatal('界面渲染失败（' + info + '）：' + message, true);
    }
  });
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error('[edgechat] 渲染错误：', error, info);
  }
}

function mountApp() {
  // 先让界面出来，再挂增强能力。顺序很关键：任何增强抛错都不会留下白屏。
  safeRun('store-initialize', () => store.initialize());

  const app = createApp(App);
  app.use(router);
  // Vue 内部捕获的渲染/生命周期错误不会触发 window 的 error 事件，
  // 过去表现为「界面莫名其妙空白且没有任何提示」，这里统一上报给兼容层。
  app.config.errorHandler = reportRenderError;

  // 关键：等路由解析完成再挂载。
  // app.use(router) 后初始导航是异步的，RouterView 在路由未解析前渲染空树；
  // 弱网手机上这段窗口能有数秒，用户看到的就是「加载中闪一下，然后白屏」。
  // 最多等 6 秒就照常挂载，避免守卫卡在慢请求上导致永久停在加载页；
  // 但挂载后必须继续自愈（ensurePainted），因为超时挂载时路由可能仍是空的。
  const routeReady = Promise.resolve()
    .then(() => router.isReady())
    .catch((error) => {
      // 守卫抛错或首个分包加载失败时，导航会被中止，首屏永远没有内容。
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[edgechat] 路由初始化失败：', error);
      }
      return Promise.resolve(router.replace('/login')).catch(noop);
    });
  const readyTimeout = new Promise((resolve) => {
    setTimeout(resolve, 6000);
  });

  Promise.race([routeReady, readyTimeout])
    .catch(() => undefined)
    .then(() => {
      safeRun('mount', () => app.mount('#app'));
      safeRun('boot-trace', () => {
        if (window.__edgechatBoot) window.__edgechatBoot.mounted = true;
      });
      afterMount(app);
      safeRun('ensure-painted', ensurePainted);
    });
}

function afterMount(app) {
  const disposeLiquidGlass = safeRun('liquid-glass', initLiquidGlass) || noop;
  app.onUnmount(() => {
    safeRun('dispose-liquid-glass', disposeLiquidGlass);
    safeRun('dispose-visual-effects', disposeVisualEffects);
  });

  safeRun('webmcp', () => {
    const modelContext = document.modelContext;
    if (modelContext && typeof modelContext.registerTool === 'function') {
      void import('./webmcp.ts')
        .then(({ registerEdgeChatWebMcp }) => registerEdgeChatWebMcp())
        .catch(() => {
          // 实验性浏览器集成不可用时，普通聊天仍应正常启动。
        });
    }
  });

  safeRun('capacitor-integration', () => installCapacitorIntegration({
    async onOpenRoom(target) {
      await router.push('/');
      queueNativeRoomTarget(target);
    }
  }));
}

// 语言包是动态 import，弱网或老内核下可能失败；无论如何都要继续执行挂载。
let i18nReady;
try {
  i18nReady = initializeI18n();
} catch (error) {
  i18nReady = Promise.resolve();
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[edgechat] i18n 初始化失败，使用默认语言：', error);
  }
}
// 语言包是动态 import：大陆弱网下若请求挂起（既不 resolve 也不 reject），
// 过去会永远停在「加载中…」占位，界面根本不挂载。这里给一个 3 秒竞速，
// 超时就用默认语言先挂载，语言包晚到时再响应式切换，不影响聊天主界面。
Promise.race([
  Promise.resolve(i18nReady).catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 3000))
]).then(mountApp);
