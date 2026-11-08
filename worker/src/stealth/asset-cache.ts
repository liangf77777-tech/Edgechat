// 静态资源缓存策略。
//
// 线上曾经把所有静态资源（包括带内容哈希的 /assets/*）都套上
// `Cache-Control: private, no-store`，并删掉 ETag / Last-Modified /
// Content-Length。后果是浏览器完全不缓存：每次打开、刷新、重进都要重新
// 下载约 270KB（Brotli 后）的全部 JS/CSS/图标。在中国大陆到 Cloudflare
// 边缘（实测 cf-ray 落在 AMS，RTT 350ms+）的链路上，这会让首屏反复超时，
// 手机上表现为「打不开」或「卡在加载中」。
//
// 修复原则：
//   - 带 Vite 内容哈希的 /assets/* 是永久不可变的，可以安全 immutable 长缓存；
//   - 不带哈希、会被替换的文件（compat.js / sw.js / manifest.json）只能协商缓存；
//   - HTML 会按登录态注入元数据，必须保持 private, no-store；
//   - 隐身模式开启时所有资源仍走 privateResponse，不得放宽（探测面防护）。

const IMMUTABLE_PREFIX = '/assets/';
const STATIC_EXTENSION = /\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf)$/i;

export function publicAssetCacheControl(pathname: string): string {
	if (pathname.startsWith(IMMUTABLE_PREFIX)) {
		return 'public, max-age=31536000, immutable, stale-while-revalidate=86400';
	}
	// Service Worker 脚本与兼容层没有内容哈希，浏览器必须用条件请求确认更新。
	if (pathname === '/sw.js' || pathname === '/compat.js') {
		return 'public, max-age=0, must-revalidate';
	}
	if (pathname === '/manifest.json') {
		return 'public, max-age=3600, must-revalidate';
	}
	if (STATIC_EXTENSION.test(pathname)) {
		return 'public, max-age=604800, stale-while-revalidate=86400';
	}
	return 'public, max-age=0, must-revalidate';
}

/** 把静态资源响应改成公共可缓存；保留协商缓存所需的头，不重建 WebSocket。 */
export function publicAssetResponse(response: Response, pathname: string): Response {
	if (response.status === 101) return response;
	const headers = new Headers(response.headers);
	// 与 privateResponse 的区别：不删 ETag / Last-Modified / Content-Length / Link，
	// 这几个头让 304 协商缓存和 HTTP/2 预加载在弱网下真正生效。
	headers.set('Cache-Control', publicAssetCacheControl(pathname));
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'same-origin');
	headers.delete('Server');
	headers.delete('X-Powered-By');
	headers.delete('Set-Cookie');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
