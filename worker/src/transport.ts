// 传输层：强制 HTTPS 与可缓存的静态资源响应头。
//
// 背景（2026-11-08 线上实测）：
//   http://x.0123.you/ 在 80 端口直接返回 200 明文，同时边缘又下发
//   `Strict-Transport-Security: max-age=0; includeSubDomains; preload`。
//   max-age=0 等于关闭 HSTS，浏览器不会主动升级到 HTTPS。中国大陆的移动
//   浏览器/微信 WebView 首次输入域名默认走 HTTP，明文响应容易被链路注入或
//   劫持，表现为「证书报错 / 打不开 / 页面内容错乱」；桌面浏览器因为已有
//   HTTPS 历史记录而正常，于是出现「只有电脑能打开」的差异。
//
// 这里在 Worker 入口统一处理，不依赖 Cloudflare 面板的 Always Use HTTPS：
//   1. 明文请求一律 301 到同路径 HTTPS；
//   2. HTTPS 响应统一带正确的 HSTS（不含 preload，preload 不可逆且当前
//      证书只覆盖 0123.you / x.0123.you / *.x.0123.you，includeSubDomains
//      已经足够，贸然 preload 会把未被证书覆盖的子域锁死）；
//   3. 本地开发域名（localhost / 127.0.0.1）不处理。

const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

function isLocalHost(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return normalized === 'localhost'
		|| normalized === '127.0.0.1'
		|| normalized === '::1'
		|| normalized.endsWith('.localhost');
}

/** 返回需要跳转到的 HTTPS 绝对地址；无需跳转时返回 null。 */
export function httpsRedirectTarget(request: Request): string | null {
	const url = new URL(request.url);
	if (isLocalHost(url.hostname)) return null;
	// 只信 Request.url 的协议：X-Forwarded-Proto 可由客户端伪造，若拿它判断，
	// 一个 https 请求带上 `X-Forwarded-Proto: http` 就会被无限重定向到自己。
	if (url.protocol !== 'http:') return null;
	const target = new URL(request.url);
	target.protocol = 'https:';
	return target.toString();
}

export function httpsRedirect(location: string): Response {
	return new Response(null, {
		status: 301,
		headers: {
			Location: location,
			'Cache-Control': 'public, max-age=3600',
			Vary: 'X-Forwarded-Proto',
		},
	});
}

/** 为 HTTPS 响应补齐安全头；WebSocket 101 不能重建 Response。 */
export function withTransportHeaders(response: Response, request: Request): Response {
	if (response.status === 101) return response;
	const url = new URL(request.url);
	if (isLocalHost(url.hostname) || url.protocol !== 'https:') return response;
	const headers = new Headers(response.headers);
	// 显式覆盖边缘下发的 max-age=0;...;preload，避免两个 HSTS 头并列。
	headers.set('Strict-Transport-Security', HSTS_VALUE);
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
