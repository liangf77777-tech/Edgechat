import { getStealthSettings } from '../data/stealth-settings.ts';
import { getLoginVerification } from '../data/login-verification.ts';
import { validateSession } from '../session.js';
import { cookieRequestAllowed, extractSessionToken } from '../session-cookie.ts';
import { gatePage, notFound, privateHeaders, submitGate } from './gate.ts';
import { publicAssetResponse } from './asset-cache.ts';
import { httpsRedirect, httpsRedirectTarget, withTransportHeaders } from '../transport.ts';
import { errorResponse, v1ErrorResponse } from '../utils.js';

function privateResponse(response: Response) {
  // WebSocket 101 不能重建为普通 Response，否则会丢失运行时 webSocket 句柄。
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  for (const key of ['Server', 'X-Powered-By', 'ETag', 'Last-Modified', 'Link', 'Content-Length']) headers.delete(key);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function assets(request: Request, env, settings, authenticated?: boolean) {
  if (!env.ASSETS) return notFound();
  const response = await env.ASSETS.fetch(request);
  if (!response.headers.get('content-type')?.includes('text/html')) {
    // 隐身关闭时静态资源是公开的：让浏览器长期缓存带内容哈希的产物，
    // 大陆弱网下重复访问不再每次全量下载。隐身开启时维持 no-store，
    // 避免未认证客户端通过缓存侧信道探测产品是否存在。
    if (!settings?.enabled) return publicAssetResponse(response, new URL(request.url).pathname);
    return privateResponse(response);
  }
  // 关闭模式的脚本/图片仍为公开资源，无需逐个查询用户；只有 HTML 的 Cookie 恢复需要验证。
  if (authenticated === undefined) {
    const token = extractSessionToken(request);
    authenticated = token ? (await validateSession(env, token)).ok : false;
  }
  if (!authenticated) return privateResponse(response);
  const html = await response.text();
  const metadata = `<meta name="app-session" content="1"><meta name="app-path" content="${settings?.enabled ? settings.apiPrefix : '/api'}">`;
  // 只有验证通过的 HTML 才收到运行时路径；永远不把 session token 写进 HTML。
  return privateResponse(new Response(html.replace('</head>', `${metadata}</head>`), {
    status: response.status, headers: response.headers,
  }));
}

async function integration(request: Request, env, ctx, dispatch) {
  if (request.method !== 'POST') return null;
  const path = new URL(request.url).pathname;
  const telegram = path === '/api/integrations/telegram/webhook'
    && request.headers.has('X-Telegram-Bot-Api-Secret-Token');
  const bridge = path === '/api/integrations/instance-bridge/v1'
    && request.headers.has('x-edgechat-signature');
  if (!telegram && !bridge) return null;
  const response = await dispatch(request, env, ctx);
  // 协议自身先验证 secret/HMAC。桥接签名错误响应只可能在认证成功后生成，应保留供对端重试判定。
  if (response.ok || (bridge && response.headers.has('x-edgechat-signature'))) return privateResponse(response);
  return notFound();
}

export function createSiteEntry(dispatch) {
  return async (request: Request, env, ctx) => {
    // 明文请求在隐身判定之前就跳 HTTPS：80 端口原本直接返回 200，
    // 大陆移动网络下会被链路注入；HSTS 又因边缘的 max-age=0 形同关闭。
    const upgrade = httpsRedirectTarget(request);
    if (upgrade) return httpsRedirect(upgrade);
    return withTransportHeaders(await siteEntry(dispatch, request, env, ctx), request);
  };
}

async function siteEntry(dispatch, request: Request, env, ctx) {
    try {
      const settings = await getStealthSettings(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;
      if (!settings?.enabled) {
        if (path.startsWith('/api/') || path.startsWith('/files/')) {
          const response = await dispatch(request, env, ctx);
          return path.startsWith('/api/auth/') ? privateResponse(response) : response;
        }
        return await assets(request, env, settings);
      }

      if (path === settings.loginPath && request.method === 'POST') return await submitGate(request, env, settings);
      const callback = await integration(request, env, ctx, dispatch);
      if (callback) return callback;
      const token = extractSessionToken(request);
      const validation = token ? await validateSession(env, token) : { ok: false };
      if (!validation.ok) {
        if ((path === '/' || path === settings.loginPath) && ['GET', 'HEAD'].includes(request.method)) {
          const response = gatePage(settings, false, 200, await getLoginVerification(env.DB));
          return request.method === 'HEAD' ? new Response(null, response) : response;
        }
        return notFound();
      }
      if (!cookieRequestAllowed(request)) return notFound();
      if (path === settings.loginPath) {
        return new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/' } });
      }
      if (path.startsWith(`${settings.apiPrefix}/`)) {
        url.pathname = `/api${path.slice(settings.apiPrefix.length)}`;
        return privateResponse(await dispatch(new Request(url, request), env, ctx));
      }
      // 旧 API 仅对已有有效凭据兼容，不为未认证客户端保留产品探测入口。
      if (path.startsWith('/api/') || path.startsWith('/files/')) {
        return privateResponse(await dispatch(request, env, ctx));
      }
      return await assets(request, env, settings, true);
    } catch (error) {
      console.error('Request failed', error);
      // 设置读取异常时也不能回退到公开 SPA；故障页面不携带应用异常或云平台信息。
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/v1/')) return privateResponse(v1ErrorResponse('temporarily_unavailable', '权限服务暂不可用', 503));
      if (path.startsWith('/api/')) return privateResponse(errorResponse('权限服务暂不可用', 503));
      return new Response('Service Unavailable', { status: 503, headers: privateHeaders });
    }
}
