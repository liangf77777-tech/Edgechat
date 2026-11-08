/**
 * 移除 @vitejs/plugin-legacy 注入的 `import.meta.resolve` 探针。
 *
 * 背景（线上真实故障）：
 *   plugin-legacy 从 v8 开始用「浏览器是否支持 import.meta.resolve」当作
 *   「这是不是现代内核」的判据，并把它写进两处会立即执行的代码：
 *
 *     1. 现代包的入口 chunk 顶部
 *        import'data:text/javascript,"assets/index-xxx.js";if(!import.meta.resolve)
 *        throw Error("import.meta.resolve not supported")';export function ...
 *     2. index.html 里的内联 module
 *        import'data:text/javascript,if(!import.meta.resolve)throw Error(...)';
 *
 *   `import.meta.resolve` 只有 Chrome 105+ / Safari 16.4+ 才有。而 iOS 12~16.3
 *   自带的 Safari、Android WebView < 105、UC / QQ 浏览器内核全都没有 —— 这些
 *   设备一进页面，内联 module 就先抛错，现代包入口的 module 求值也随之失败，
 *   于是「什么都没渲染 + 控制台一条 import.meta.resolve not supported」，
 *   兼容层的 error 监听再把这条错误翻译成「页面加载遇到问题」卡片。
 *
 *   但我们的现代包 target 是 es2015（Chrome 51+ / Safari 10+ / Edge 15+），
 *   上面那些内核完全跑得动。探针属于误判，必须删掉。
 *
 * 删掉之后行为不变的部分：
 *   - `import.meta.url` / 动态 import / async generator 的语法探测依然保留，
 *     真正跑不动现代包的内核（iOS 10/11、Chrome < 61）仍然解析失败 →
 *     `window.__vite_is_modern_browser` 不被置位 → 落到 nomodule 里的
 *     SystemJS + ES5 备份包。
 *   - 预加载助手里的 `import.meta.resolve ? ... : new URL(...)` 是带兜底的
 *     三元表达式，不属于探针，必须原样保留 —— 所以这里不用正则通杀，
 *     只删「import 'data:text/javascript,...' 且内容含该报错」这一种形态。
 *
 * 导出的是纯函数 + 插件工厂，方便单测直接引用（不依赖 vite / vue）。
 */

const PROBE_MARKER = 'import.meta.resolve not supported';
const DATA_URL_PREFIX = 'data:text/javascript,';

/** 从一个字符串字面量的起始引号位置，找到配对的结束引号（跳过 \ 转义）。 */
function findStringEnd(code, quoteIndex) {
  const quote = code[quoteIndex];
  for (let i = quoteIndex + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

/**
 * 删掉所有 `import 'data:text/javascript,...'` 且内容里带 import.meta.resolve
 * 报错的导入语句。其它 `import.meta.resolve` 用法一律不动。
 */
export function stripLegacyGuardProbe(source) {
  if (typeof source !== 'string' || source.indexOf(PROBE_MARKER) === -1) return source;

  let out = '';
  let cursor = 0;

  while (cursor < source.length) {
    const hit = source.indexOf('import', cursor);
    if (hit === -1) {
      out += source.slice(cursor);
      break;
    }

    let quoteIndex = hit + 'import'.length;
    while (quoteIndex < source.length && /\s/.test(source[quoteIndex])) quoteIndex += 1;

    const quote = source[quoteIndex];
    if (quote === "'" || quote === '"') {
      const bodyStart = quoteIndex + 1;
      if (source.startsWith(DATA_URL_PREFIX, bodyStart)) {
        const end = findStringEnd(source, quoteIndex);
        if (end > -1 && source.slice(bodyStart, end).indexOf(PROBE_MARKER) > -1) {
          out += source.slice(cursor, hit);
          let next = end + 1;
          if (source[next] === ';') next += 1;
          cursor = next;
          continue;
        }
      }
    }

    out += source.slice(cursor, hit + 'import'.length);
    cursor = hit + 'import'.length;
  }

  return out;
}

/** 代码里是否还残留探针。 */
export function hasLegacyGuardProbe(source) {
  return typeof source === 'string' && source.indexOf(PROBE_MARKER) > -1;
}

/**
 * Vite 插件：
 *   - renderChunk（enforce: post）删掉现代包入口 chunk 顶部的探针；
 *   - generateBundle 处理已经注入到 index.html 里的内联探针，并做一次断言，
 *     防止插件升级换文案后悄悄把探针放回去。
 */
export function legacyGuardProbePlugin() {
  return {
    name: 'edgechat:legacy-guard-probe',
    enforce: 'post',

    renderChunk(code) {
      if (!hasLegacyGuardProbe(code)) return null;
      const next = stripLegacyGuardProbe(code);
      if (next === code) return null;
      return { code: next, map: null };
    },

    generateBundle(_options, bundle) {
      for (const file of Object.keys(bundle)) {
        const item = bundle[file];
        if (item.type === 'chunk') {
          // renderChunk 已经处理过一次；这里再兜一层，防止插件顺序变化后漏删。
          if (hasLegacyGuardProbe(item.code)) {
            const next = stripLegacyGuardProbe(item.code);
            if (next !== item.code) item.code = next;
          }
          continue;
        }
        if (!/\.html?$/.test(file)) continue;
        const html = typeof item.source === 'string'
          ? item.source
          : Buffer.from(item.source).toString('utf8');
        const next = stripLegacyGuardProbe(html);
        if (next !== html) item.source = next;
      }

      const leaked = [];
      for (const file of Object.keys(bundle)) {
        const item = bundle[file];
        const text = item.type === 'chunk'
          ? item.code
          : typeof item.source === 'string'
            ? item.source
            : '';
        if (hasLegacyGuardProbe(text)) leaked.push(file);
      }
      if (leaked.length) {
        this.error(
          '[edgechat] legacy 探针没有被移除：' + leaked.join(', ') +
          '。@vitejs/plugin-legacy 可能改了注入格式，请更新 frontend/legacy-guard-probe.js。'
        );
      }
    }
  };
}
