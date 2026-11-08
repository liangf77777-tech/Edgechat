import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	httpsRedirect,
	httpsRedirectTarget,
	withTransportHeaders,
} from '../worker/src/transport.ts';
import {
	publicAssetCacheControl,
	publicAssetResponse,
} from '../worker/src/stealth/asset-cache.ts';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('明文请求一律跳 HTTPS，本地开发与已加密请求不处理', () => {
	assert.equal(
		httpsRedirectTarget(new Request('http://x.0123.you/settings?a=1')),
		'https://x.0123.you/settings?a=1',
	);
	assert.equal(httpsRedirectTarget(new Request('https://x.0123.you/')), null);
	assert.equal(httpsRedirectTarget(new Request('http://127.0.0.1:8787/')), null);
	assert.equal(httpsRedirectTarget(new Request('http://localhost:5173/')), null);
	// 反代后的 Worker 仍能看到真实协议。
	assert.equal(
		httpsRedirectTarget(new Request('https://x.0123.you/', {
			headers: { 'X-Forwarded-Proto': 'http' },
		})),
		null,
		'X-Forwarded-Proto 只在 URL 为 http 时作为判据，避免代理头伪造造成重定向环',
	);
	const redirect = httpsRedirect('https://x.0123.you/');
	assert.equal(redirect.status, 301);
	assert.equal(redirect.headers.get('location'), 'https://x.0123.you/');
	assert.match(redirect.headers.get('cache-control'), /max-age=3600/);
});

test('HTTPS 响应带可生效的 HSTS，且不并列 preload / 不破坏 WebSocket', () => {
	const response = withTransportHeaders(
		new Response('ok', { headers: { 'Content-Type': 'text/plain' } }),
		new Request('https://x.0123.you/'),
	);
	assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
	assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

	// 101 不能由 Response 构造（undici 限制），用一个最小桩验证提前返回即可。
	const ws = { status: 101 };
	assert.equal(withTransportHeaders(ws, new Request('https://x.0123.you/api/ws')), ws);
	assert.equal(
		withTransportHeaders(new Response('ok'), new Request('http://localhost/')).headers.get('strict-transport-security'),
		null,
	);
});

test('带内容哈希的产物长缓存，不带哈希的文件只做协商缓存', () => {
	assert.match(publicAssetCacheControl('/assets/index-Wv5q9Rl_.js'), /max-age=31536000, immutable/);
	assert.match(publicAssetCacheControl('/assets/index-B3HKVtA_.css'), /immutable/);
	for (const path of ['/sw.js', '/compat.js']) {
		const value = publicAssetCacheControl(path);
		assert.match(value, /max-age=0, must-revalidate/, path);
		assert.doesNotMatch(value, /immutable/, path);
	}
	assert.match(publicAssetCacheControl('/manifest.json'), /max-age=3600/);
	assert.match(publicAssetCacheControl('/logo.svg'), /max-age=604800/);
	assert.match(publicAssetCacheControl('/unknown'), /must-revalidate/);
});

test('公开静态资源保留 ETag / Last-Modified / Content-Length / Link', () => {
	const source = new Response('body', {
		headers: {
			'Content-Type': 'text/javascript',
			'Cache-Control': 'private, no-store',
			ETag: '"hash"',
			'Last-Modified': 'Sat, 08 Nov 2026 00:00:00 GMT',
			'Content-Length': '4',
			Link: '</assets/icons.js>; rel=modulepreload',
			Server: 'product',
		},
	});
	const result = publicAssetResponse(source, '/assets/index-abc.js');
	assert.match(result.headers.get('cache-control'), /immutable/);
	assert.equal(result.headers.get('etag'), '"hash"');
	assert.equal(result.headers.get('last-modified'), 'Sat, 08 Nov 2026 00:00:00 GMT');
	assert.equal(result.headers.get('content-length'), '4');
	assert.match(result.headers.get('link'), /modulepreload/);
	assert.equal(result.headers.get('server'), null);
	assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
});

test('隐身关闭时静态资源可缓存、HTML 仍旧 no-store；隐身开启时维持严格私有', async () => {
	const entry = await read('worker/src/stealth/entry.ts');
	assert.match(entry, /if \(!settings\?\.enabled\) return publicAssetResponse/);
	assert.match(entry, /return privateResponse\(response\)/);
	assert.ok(entry.includes("!response.headers.get('content-type')?.includes('text/html')"));
	assert.match(entry, /privateResponse\(new Response\(html\.replace/);
});

test('入口统一处理 HTTPS 跳转与安全头', async () => {
	const entry = await read('worker/src/stealth/entry.ts');
	assert.match(entry, /httpsRedirectTarget\(request\)/);
	assert.match(entry, /httpsRedirect\(upgrade\)/);
	assert.match(entry, /withTransportHeaders\(await siteEntry/);
});

test('Service Worker 只缓存带哈希资源，导航与 API 一律透传', async () => {
	const sw = await read('frontend/public/sw.js');
	assert.match(sw, /url\.pathname\.startsWith\('\/assets\/'\)/);
	assert.match(sw, /if \(!immutableAsset\(event\.request\)\) return;/);
	assert.match(sw, /if \(response && response\.ok\)/);
	assert.doesNotMatch(sw, /request\.mode === 'navigate'[\s\S]*respondWith/);
});

test('启动链路不再把网络超时当成登出，也不再依赖原生 AbortSignal.timeout', async () => {
	const store = await read('frontend/src/store.js');
	const api = await read('frontend/src/api.js');
	const router = await read('frontend/src/router.js');
	const main = await read('frontend/src/main.js');
	assert.match(store, /status === 401 \|\| status === 403/);
	assert.match(store, /get hasCredentials\(\)/);
	assert.match(router, /return store\.hasCredentials \? true : '\/login'/);
	assert.match(router, /Promise\.race\(\[store\.initialize\(\), timeout\]\)/);
	assert.match(main, /Promise\.race\(\[[\s\S]*setTimeout\(resolve, 3000\)/);
	assert.doesNotMatch(api, /request\('\/auth\/session', \{ signal: AbortSignal\.timeout/);
	assert.match(api, /DEFAULT_REQUEST_TIMEOUT_MS = 20000/);
	assert.match(api, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
});
