// 媒体查询兼容封装。
//
// public/compat.js 已经给 MediaQueryList 补了 addEventListener，但业务代码仍
// 自带一层防护：某些 WebView 会缓存旧版 HTML/脚本、或者把页面嵌进不支持 SW
// 的容器，此时这里仍然要保证「初始化不会抛错」。iOS 13 及以下、微信 X5 老内核
// 只有废弃的 addListener()，直接调 addEventListener 会在 Vue 挂载前中断应用。

const EMPTY_QUERY = Object.freeze({
  media: '',
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {}
});

export function safeMatchMedia(query, globalObject = typeof window !== 'undefined' ? window : undefined) {
  try {
    if (!globalObject || typeof globalObject.matchMedia !== 'function') return EMPTY_QUERY;
    return globalObject.matchMedia(query) || EMPTY_QUERY;
  } catch {
    // 少数内核对无法识别的 media feature 会直接抛错（如旧的 reduced-transparency）。
    return EMPTY_QUERY;
  }
}

export function onMediaQueryChange(query, handler) {
  if (!query || typeof handler !== 'function') return () => {};

  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handler);
    return () => {
      if (typeof query.removeEventListener === 'function') query.removeEventListener('change', handler);
    };
  }

  if (typeof query.addListener === 'function') {
    query.addListener(handler);
    return () => {
      if (typeof query.removeListener === 'function') query.removeListener(handler);
    };
  }

  return () => {};
}
