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

function mountApp() {
  // 先让界面出来，再挂增强能力。顺序很关键：任何增强抛错都不会留下白屏。
  safeRun('store-initialize', () => store.initialize());

  const app = createApp(App);
  app.use(router);
  app.mount('#app');

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
Promise.resolve(i18nReady)
  .catch(() => {})
  .then(mountApp);
