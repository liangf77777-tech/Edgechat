// Edgechat service worker.
// 除 PWA 可安装条件外，还负责缓存「带内容哈希、永不改变」的 /assets/* 构建产物。
// 中国大陆到 Cloudflare 边缘的 RTT 很高（实测落在 AMS），每次打开都重新下载
// 全部 JS/CSS 会让弱网手机反复超时。/assets/* 文件名由 Vite 按内容生成，
// 内容一变文件名就变，因此 cache-first 不会出现旧代码残留。
//
// 严格不拦截：HTML 导航、/api/、/files/、WebSocket、非 GET、跨域请求。
// 这些请求一律交给浏览器默认网络栈——过去在 SW 里 respondWith 导航请求曾
// 导致 mobile Safari / 微信 WKWebView 整页空白，这个约束不能放宽。
const STATIC_CACHE = 'edgechat-assets-v1';

function immutableAsset(request) {
  if (request.method !== 'GET') return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  if (url.origin !== self.location.origin) return false;
  // 只放行 Vite 产物目录；compat.js / sw.js / manifest / 图标不带哈希，不缓存。
  if (!url.pathname.startsWith('/assets/')) return false;
  return /\.(?:js|mjs|css|svg|png|jpe?g|webp|woff2?|ttf)$/i.test(url.pathname);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 历史版本的缓存一律清掉：旧 SW 曾经缓存过带 hash 的旧资源，
      // 换版后这些文件已从服务器删除，命中旧缓存会让整页加载失败、白屏。
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
        // Cache Storage 不可用时忽略。
      }
      await self.clients.claim();
    })(),
  );
});

// 允许页面请求一键清理（兼容层的「清除缓存并重新加载」会用到）。
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'edgechat:purge') {
    event.waitUntil(
      (async () => {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        } catch {
          // 忽略。
        }
        if (event.source && typeof event.source.postMessage === 'function') {
          event.source.postMessage({ type: 'edgechat:purged' });
        }
      })(),
    );
  }
});

// 只为不可变的带哈希资源启用 cache-first。其余请求（尤其是导航、API、WS）
// 不调用 respondWith，完全交由浏览器默认网络栈，保留原有的白屏防护语义。
self.addEventListener('fetch', (event) => {
  if (!immutableAsset(event.request)) return;
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      // 只缓存成功响应；失败时直接把错误交回浏览器，不伪造兜底内容。
      if (response && response.ok) {
        try { await cache.put(event.request, response.clone()); } catch { /* 配额不足时忽略 */ }
      }
      return response;
    }),
  );
});

// Focus (or open) the app when a system notification is clicked, and tell the
// page which room it belongs to so it can navigate there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const client = clientList.find((c) => 'focus' in c);
        if (client) {
          client.postMessage({ type: 'edgechat:notification-click', data });
          return client.focus();
        }
        const url = new URL('/', self.location.origin);
        if (data.roomKind && Number.isSafeInteger(Number(data.roomId)) && Number(data.roomId) > 0) {
          url.searchParams.set('notificationRoomKind', data.roomKind);
          url.searchParams.set('notificationRoomId', String(data.roomId));
        }
        return self.clients.openWindow(url.href);
      }),
  );
});
