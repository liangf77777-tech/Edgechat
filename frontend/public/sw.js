// Edgechat minimal service worker.
// Purpose: satisfy the PWA installability requirement so Chrome/Edge show the
// install button in the address bar. It intentionally does NOT cache anything
// and does NOT intercept API, /files, or WebSocket traffic — every request is
// passed straight through to the network.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Keep a fetch listener (older Chrome still requires one for the install
// prompt) but never call respondWith. Previously every same-origin GET,
// including the HTML navigation itself, went through respondWith(fetch(req)).
// On mobile Safari / WeChat WKWebView a failed or redirected navigation fetch
// inside a Service Worker makes the whole page render blank with no recovery.
// Passing through to the browser's default network stack removes that risk.
self.addEventListener('fetch', () => {
  // Intentionally empty: no caching, no interception, no stale assets.
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
