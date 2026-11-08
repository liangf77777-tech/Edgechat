import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { reactive } from 'vue';
import api from '../frontend/src/api.js';
import { normalizeSiteColorTheme } from '../shared/site-theme.ts';

const read = (name) => readFileSync(new URL(`../frontend/src/${name}`, import.meta.url), 'utf8');
const withoutImports = (source) => source
  .replace(/^import ['"][^'"]+['"];\r?\n/gm, '')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Windows 检出可能使用 CRLF；测试应执行同一段业务逻辑，而不是依赖 Git 的换行设置。
test('startup test source extraction supports LF and CRLF checkouts', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = ["import './styles.css';", 'import {', '  reactive', "} from 'vue';", 'const ready = true;'].join(newline);
    assert.equal(withoutImports(source), 'const ready = true;');
  }
});

function startup({ token = '', native = false, origin = '', documentSession = false, site, session } = {}) {
  const calls = { site: 0, session: 0, metadata: [], themes: [] };
  const context = {
    reactive, AbortController, normalizeSiteColorTheme,
    isDemoMode: false, runtimeSessionToken: '', isCapacitorAndroid: native,
    hasDocumentSession: documentSession, isGatewayMode: documentSession,
    getStoredToken: () => token,
    setStoredToken: (value) => { token = value; },
    clearStoredToken: () => { token = ''; },
    getStoredNativeServerOrigin: () => origin,
    setStoredNativeServerOrigin: (value) => { origin = value; return value; },
    restoreStoredNativeServerOrigin: (value) => { origin = value; },
    applySiteMetadata: (value) => calls.metadata.push({ ...value }),
    applySiteColorTheme: (value) => calls.themes.push(value),
    api: {
      getSite: () => { calls.site++; return typeof site === 'function' ? site() : site || new Promise(() => {}); },
      session: () => { calls.session++; return session || new Promise(() => {}); }
    }
  };
  const store = runInNewContext(withoutImports(read('store.js')).replace('export default', 'globalThis.store ='), context);
  return { store, calls, storedToken: () => token };
}

function routeGuard(store) {
  const router = { beforeEach(guard) { this.guard = guard; } };
  runInNewContext(withoutImports(read('router.js')).replace('export default router;', ''), {
    store, isCapacitorAndroid: false, isDemoMode: false, setTimeout, clearTimeout,
    createRouter: () => router, createWebHistory() {}, createWebHashHistory() {}
  });
  return router.guard;
}

test('the entry point mounts the application while authentication is still pending', async () => {
  const calls = [];
  runInNewContext(withoutImports(read('main.js')), {
    window: {}, navigator: {}, document: {}, App: {}, router: { isReady: () => Promise.resolve() },
    Capacitor: { isNativePlatform: () => false },
    localStorage: { getItem: () => null }, setTimeout, clearTimeout,
    installChunkLoadRecovery() {}, takeNotificationRoomTarget: () => null,
    initializeI18n: () => Promise.resolve(),
    store: { initialize() { calls.push('initialize'); return new Promise(() => {}); } },
    // config 是真实 Vue app 的一等属性；入口会在这里挂 errorHandler。
    createApp: () => ({ config: {}, onUnmount() {}, use() { calls.push('router'); }, mount() { calls.push('mount'); } }),
    installCapacitorIntegration() {}, initLiquidGlass() {}, initVisualEffects() {}
  });
  await flush();
  assert.deepEqual(calls, ['initialize', 'router', 'mount']);
});

test('a pending site request never blocks anonymous startup or the login route', async () => {
  const { store, calls } = startup();
  await store.initialize();
  assert.equal(store.ready, true);
  assert.equal(store.site.siteName, 'Edgechat');
  assert.equal(store.site.colorTheme, 'default');
  assert.equal(calls.site, 1);
  assert.equal(calls.session, 0);
  assert.equal(await routeGuard(store)({ path: '/login', meta: { public: true } }), true);
  assert.equal(await routeGuard(store)({ path: '/', meta: {} }), '/login');
});

test('session restoration runs beside metadata and concurrent initialization shares authentication', async () => {
  const site = Promise.withResolvers();
  const session = Promise.withResolvers();
  const { store, calls, storedToken } = startup({ token: 'stored', site: site.promise, session: session.promise });
  const first = store.initialize();
  assert.equal(first, store.initialize());
  assert.equal(calls.site, 1);
  assert.equal(calls.session, 1);
  assert.equal(store.ready, false);
  let navigated = false;
  const navigation = routeGuard(store)({ path: '/', meta: {} }).then((result) => {
    navigated = true;
    return result;
  });
  await flush();
  assert.equal(navigated, false);
  session.resolve({ session: { token: 'restored' } });
  await first;
  assert.equal(await navigation, true);
  assert.equal(storedToken(), 'restored');
  assert.equal(store.site.siteName, 'Edgechat');
  site.resolve({ site: { siteName: 'Custom site', siteIconUrl: '/custom.png', colorTheme: 'cream-sakura' } });
  await flush();
  assert.equal(store.site.siteName, 'Custom site');
  assert.equal(calls.metadata.at(-1).siteIconUrl, '/custom.png');
  assert.equal(calls.themes.at(-1), 'cream-sakura');
  await store.initialize();
  assert.equal(calls.session, 1);
});

test('metadata failures preserve defaults and cannot clear a restored session', async () => {
  const site = Promise.withResolvers();
  const { store, calls } = startup({ token: 'stored', site: site.promise, session: Promise.resolve({ session: { token: 'valid' } }) });
  await store.initialize();
  site.reject(new Error('network unavailable'));
  await flush();
  assert.equal(store.ready, true);
  assert.equal(store.session.token, 'valid');
  assert.equal(calls.metadata.at(-1).siteName, 'Edgechat');
});

test('服务端判定凭证失效时关闭受保护路由并清除本地登录态', async () => {
  const session = Promise.withResolvers();
  const { store, storedToken } = startup({ token: 'expired', session: session.promise });
  const navigation = routeGuard(store)({ path: '/', meta: {} });
  const unauthorized = new Error('unauthorized');
  unauthorized.status = 401;
  session.reject(unauthorized);
  assert.equal(await navigation, '/login');
  assert.equal(store.ready, true);
  assert.equal(store.session, null);
  assert.equal(storedToken(), '');
});

test('网络超时不清除登录态，弱网手机可乐观进入聊天主界面', async () => {
  const session = Promise.withResolvers();
  const { store, storedToken } = startup({ token: 'valid-but-slow', session: session.promise });
  const navigation = routeGuard(store)({ path: '/', meta: {} });
  // 没有 HTTP status 即链路问题（超时/断网/老内核 TypeError），不是登出。
  session.reject(new Error('network timeout'));
  assert.equal(await navigation, true);
  assert.equal(store.ready, true);
  assert.equal(store.session, null);
  assert.equal(store.hasCredentials, true);
  assert.equal(storedToken(), 'valid-but-slow', '弱网下不得把用户踢出登录态');
});

test('gateway startup drops stale bearer credentials before restoring the document cookie session', async () => {
  const session = Promise.withResolvers();
  const { store, storedToken, calls } = startup({ token: 'old-account', documentSession: true, session: session.promise });
  const pending = store.initialize();
  assert.equal(storedToken(), '');
  assert.equal(calls.session, 1);
  session.resolve({ session: { token: 'cookie-account' } });
  await pending;
  assert.equal(store.session.token, 'cookie-account');
});

test('native first launch skips requests; a configured server restores independently of metadata', async () => {
  const first = startup({ native: true, token: 'stale' });
  await first.store.initialize();
  assert.equal(first.store.ready, true);
  assert.equal(first.storedToken(), '');
  assert.equal(first.calls.site, 0);
  assert.equal(first.calls.session, 0);
  const configured = startup({ native: true, origin: 'https://chat.example', token: 'stored', session: Promise.resolve({ session: { token: 'restored' } }) });
  await configured.store.initialize();
  assert.equal(configured.store.session.token, 'restored');
  assert.equal(configured.calls.site, 1);
});

test('late native metadata cannot overwrite a newly configured server', async () => {
  const oldSite = Promise.withResolvers();
  const newSite = Promise.withResolvers();
  const responses = [oldSite.promise, newSite.promise];
  const { store } = startup({ native: true, origin: 'https://old.example', site: () => responses.shift() });
  await store.initialize();
  const changing = store.configureNativeServer('https://new.example');
  newSite.resolve({ site: { siteName: 'New site' } });
  await changing;
  oldSite.resolve({ site: { siteName: 'Old site' } });
  await flush();
  assert.equal(store.site.siteName, 'New site');
});

test('site and session API requests abort after a bounded wait', async (t) => {
  // 会话恢复给到 12 秒并对「无 HTTP 状态」的链路失败重试一次；站点元数据保持 10 秒。
  for (const [method, expectedTimeout] of [['getSite', 10000], ['session', 12000]]) {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
      assert.equal(milliseconds, expectedTimeout);
      return controller.signal;
    });
    let requestUrl;
    let fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', (url, { signal }) => {
      requestUrl = url;
      fetchCalls += 1;
      return new Promise((_, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const request = api[method]();
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    await assert.rejects(request, { name: 'TimeoutError' });
    assert.equal(requestUrl, method === 'getSite' ? '/api/site' : '/api/auth/session');
    assert.equal(fetchCalls, method === 'session' ? 2 : 1, '会话恢复对网络超时重试一次');
    t.mock.restoreAll();
  }
});
