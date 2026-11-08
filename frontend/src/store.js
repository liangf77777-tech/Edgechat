import { reactive } from 'vue';
import {
  getStoredNativeServerOrigin,
  isCapacitorAndroid,
  restoreStoredNativeServerOrigin,
  setStoredNativeServerOrigin
} from './capacitor-platform.ts';
import { isDemoMode, runtimeSessionToken } from './runtime.js';
import api from './api.js';
import { applySiteMetadata } from './site-metadata.js';
import { normalizeSiteColorTheme } from '../../shared/site-theme.ts';
import { applySiteColorTheme } from './site-theme.ts';
import { hasDocumentSession, isGatewayMode } from './gateway.ts';
import {
  addAuthInvalidListener,
  clearStoredToken,
  getStoredToken,
  setStoredToken
} from './auth-storage.js';

let loginProbeController;

function collectLoginNetwork(session) {
  if (isDemoMode || isCapacitorAndroid || !session.loginProbeId) return;
  loginProbeController?.abort();
  const controller = new AbortController();
  loginProbeController = controller;
  // 探测失败不影响登录；先记一次性 ID，刷新和重新进入后台时不重复加载或探测。
  void (async () => {
    if (localStorage.getItem('edgechat.login-probe') === session.loginProbeId) return;
    localStorage.setItem('edgechat.login-probe', session.loginProbeId);
    const { probeWebRtc } = await import('./login-network.ts');
    if (controller.signal.aborted) return;
    const result = await probeWebRtc({ signal: controller.signal });
    if (controller.signal.aborted || state.token !== session.token) return;
    await api.reportLoginNetwork(session.loginProbeId, result, { signal: controller.signal });
  })().catch(() => {});
}

const state = reactive({
  ready: false,
  token: isDemoMode ? runtimeSessionToken : getStoredToken(),
  session: null,
  site: {
    siteName: 'Edgechat',
    siteIconUrl: '',
    colorTheme: 'default'
  }
});

function clearAuthState() {
  loginProbeController?.abort();
  clearStoredToken();
  state.token = '';
  state.session = null;
}

async function loadSite() {
  const serverOrigin = getStoredNativeServerOrigin();
  try {
    const payload = await api.getSite();
    // 原生客户端可能已切换服务地址，旧站点的后台响应不能覆盖新配置。
    if (serverOrigin === getStoredNativeServerOrigin()) setSite(payload.site);
  } catch {
    applySiteMetadata(state.site);
  }
}

let initialization;
function initialize() {
  if (state.ready) return Promise.resolve();
  // 入口与路由守卫共用同一次鉴权，避免提前挂载后重复恢复会话。
  if (!initialization) initialization = initializeSession();
  return initialization;
}

async function initializeSession() {
  if (state.ready) {
    return;
  }

  if (isCapacitorAndroid && !getStoredNativeServerOrigin()) {
    clearAuthState();
    state.ready = true;
    return;
  }

  if (hasDocumentSession && !isDemoMode && !isCapacitorAndroid) {
    // 网关登录可能切换了账号，不能让之前 localStorage 中的旧 token 覆盖刚验证的 Cookie。
    clearAuthState();
  }
  // 名称、图标和配色独立加载，默认外观即可展示基础界面。
  setSite(state.site);
  void loadSite();

  if (!state.token && !hasDocumentSession) {
    state.ready = true;
    return;
  }

  try {
    const payload = await api.session();
    state.session = payload.session;
    state.token = payload.session.token;
    setStoredToken(state.token);
    collectLoginNetwork(payload.session);
  } catch (error) {
    const status = Number(error && error.status);
    // 只有服务端明确判定凭证无效时才清除登录态。超时、断网、老内核缺失
    // AbortSignal.timeout 这类链路/运行时问题一律保留 token：过去把它们当成
    // 登出，导致大陆弱网手机「登录→跳回登录页」无限循环，永远进不了聊天页。
    // 真正的 401 会由 api 层派发 auth-invalid，仍会正常回到登录页。
    if (status === 401 || status === 403) {
      clearAuthState();
    } else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[edgechat] 会话恢复受网络影响，保留本地登录态：', error);
    }
  } finally {
    state.ready = true;
  }
}

async function login(credentials) {
  const payload = await api.login(credentials);
  state.token = payload.token;
  state.session = payload.session;
  state.ready = true;
  setStoredToken(payload.token);
  collectLoginNetwork(payload.session);
}

async function configureNativeServer(configuredOrigin) {
  if (!isCapacitorAndroid) {
    return '';
  }

  const previousOrigin = getStoredNativeServerOrigin();
  const nextOrigin = setStoredNativeServerOrigin(configuredOrigin);
  try {
    const payload = await api.getSite();
    if (nextOrigin !== previousOrigin) {
      clearAuthState();
    }
    setSite(payload.site);
    return nextOrigin;
  } catch (error) {
    restoreStoredNativeServerOrigin(previousOrigin);
    throw new Error('native_server_unavailable', { cause: error });
  }
}

async function logout() {
  try {
    if (state.token) {
      await api.logout();
    }
  } finally {
    clearAuthState();
    if (!isDemoMode && !isCapacitorAndroid) window.location.replace('/');
  }
}

function setSession(session) {
  state.session = session;
}
let authorizationRefresh;
function refreshAuthorization() {
  if (!state.session) return Promise.resolve();
  if (!authorizationRefresh) authorizationRefresh = api.authorization().then(({ authorization }) => {
    if (state.session) state.session = { ...state.session, ...authorization };
  }).catch((error) => {
    if (state.session) state.session = { ...state.session, canAccessAdmin: false, isSuperAdmin: false, permissions: [] };
    throw error;
  }).finally(() => { authorizationRefresh = null; });
  return authorizationRefresh;
}

function setSite(site) {
  state.site = {
    siteName: String(site?.siteName || 'Edgechat').trim() || 'Edgechat',
    siteIconUrl: String(site?.siteIconUrl || '').trim(),
    colorTheme: normalizeSiteColorTheme(site?.colorTheme)
  };
  applySiteColorTheme(state.site.colorTheme);
  applySiteMetadata(state.site);
}

if (typeof window !== 'undefined') {
  window.addEventListener('authorization-changed', () => { void refreshAuthorization().catch(() => {}); });
  addAuthInvalidListener(() => {
    clearAuthState();
    if (isGatewayMode) window.location.replace('/');
  });
}

export default {
  get ready() {
    return state.ready;
  },
  get token() {
    return state.token;
  },
  get session() {
    return state.session;
  },
  // 会话恢复还没回来时，本地凭据或网关 Cookie 足以证明用户可能已登录。
  // 路由守卫据此乐观放行，避免弱网下被卡在登录页；若后台校验返回 401，
  // api 层会派发 auth-invalid 并把页面带回登录页。
  get hasCredentials() {
    return Boolean(state.token) || Boolean(hasDocumentSession);
  },
  get site() {
    return state.site;
  },
  initialize,
  login,
  configureNativeServer,
  logout,
  setSession,
  setSite,
  loadSite,
  refreshAuthorization
};
