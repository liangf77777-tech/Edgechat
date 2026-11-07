import { computed, readonly, ref } from 'vue';

export const SIMPLIFIED_CHINESE_LOCALE = 'zh-CN';
export const TRADITIONAL_CHINESE_LOCALE = 'zh-TW';
export const ENGLISH_LOCALE = 'en-US';
// 保留旧名称，避免现有调用方把“简体中文”误当成全部中文后产生兼容改动。
export const CHINESE_LOCALE = SIMPLIFIED_CHINESE_LOCALE;
export const LOCALE_OPTIONS = Object.freeze([
  { value: SIMPLIFIED_CHINESE_LOCALE, label: '简体中文' },
  { value: TRADITIONAL_CHINESE_LOCALE, label: '繁體中文' },
  { value: ENGLISH_LOCALE, label: 'English' }
]);

const STORAGE_KEY = 'edgechat.locale';
const TRADITIONAL_CHINESE_REGIONS = new Set(['tw', 'hk', 'mo']);

// 不用 Object.hasOwn / String.prototype.replaceAll：这些是 ES2021/2022 才有的
// 运行时 API，模块顶层一旦调用就会让老手机内核整体加载失败（白屏）。
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(Object(object), key);

function readStoredLocale() {
  try {
    return typeof localStorage === 'undefined' ? '' : localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    // 无痕模式 / 禁用 DOM storage 的浏览器。
    return '';
  }
}

function writeStoredLocale(value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    // 偏好存不下不影响本次会话的语言切换。
  }
}
const localeLoaders = {
  [SIMPLIFIED_CHINESE_LOCALE]: () => import('./locales/zh-CN.js'),
  [TRADITIONAL_CHINESE_LOCALE]: () => import('./locales/zh-TW.js'),
  [ENGLISH_LOCALE]: () => import('./locales/en-US.js')
};

function normalizeLocale(value) {
  return hasOwn(localeLoaders, value) ? value : ENGLISH_LOCALE;
}

export function detectBrowserLocale(value) {
  const language = String(value || '').split('_').join('-');
  if (!/^zh(?:-|$)/i.test(language)) return ENGLISH_LOCALE;
  const subtags = language.toLowerCase().split('-').slice(1);

  // 脚本标签代表用户明确选择的字形，优先级高于设备地区；CHT/CHS 兼容旧版浏览器标签。
  if (subtags.includes('hant') || subtags.includes('cht')) return TRADITIONAL_CHINESE_LOCALE;
  if (subtags.includes('hans') || subtags.includes('chs')) return SIMPLIFIED_CHINESE_LOCALE;

  // 未声明脚本时，台湾、香港、澳门使用繁体，其余中文地区与裸 zh 默认简体。
  return subtags.some((subtag) => TRADITIONAL_CHINESE_REGIONS.has(subtag))
    ? TRADITIONAL_CHINESE_LOCALE
    : SIMPLIFIED_CHINESE_LOCALE;
}

function initialLocale() {
  const storedLocale = readStoredLocale();
  if (hasOwn(localeLoaders, storedLocale)) return storedLocale;
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const browserLanguage = (nav && nav.languages && nav.languages[0]) || (nav && nav.language);
  return detectBrowserLocale(browserLanguage);
}

const locale = ref(initialLocale());
const localeLoading = ref(false);
const activeMessages = ref({});
let translateServerError = (message) => message;

function interpolate(template, params) {
  return template.replace(/\{([a-zA-Z][\w]*)\}/g, (match, key) =>
    hasOwn(params, key) ? String(params[key]) : match
  );
}

function applyDocumentLocale() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale.value;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', t('app.description'));
}

export function t(key, params = {}) {
  const template = activeMessages.value[key] ?? key;
  return interpolate(template, params);
}

export function localizeServerError(value) {
  const message = String(value || '');
  return message ? translateServerError(message) : message;
}

export async function setLocale(value, { persist = true } = {}) {
  const nextLocale = normalizeLocale(value);
  localeLoading.value = true;
  try {
    const localeModule = await localeLoaders[nextLocale]();
    activeMessages.value = localeModule.default;
    translateServerError = localeModule.localizeServerError || ((message) => message);
    locale.value = nextLocale;
    if (persist) writeStoredLocale(nextLocale);
    applyDocumentLocale();
  } finally {
    localeLoading.value = false;
  }
}

export function initializeI18n() {
  return setLocale(locale.value, { persist: false });
}

const SQLITE_UTC_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function parseDateValue(value) {
  if (value instanceof Date) return value;
  // D1 的 CURRENT_TIMESTAMP 是 UTC，但返回值没有时区标记；补成 ISO UTC 后才能按浏览器时区正确展示。
  const normalizedValue =
    typeof value === 'string' && SQLITE_UTC_DATE_TIME_PATTERN.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  return new Date(normalizedValue);
}

// dateStyle / timeStyle 是 ES2021，iOS 13 / Chrome 76 以下会抛 RangeError。
// 构造失败时退回显式字段，保证消息时间戳在老手机上依然是普通文本。
function createFormatter(options, fallback) {
  try {
    return new Intl.DateTimeFormat(locale.value, options);
  } catch (error) {
    return new Intl.DateTimeFormat(locale.value, fallback);
  }
}

const DATETIME_FALLBACK = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
const DATE_FALLBACK = { year: 'numeric', month: 'short', day: 'numeric' };

// 只缓存三个固定展示格式；自定义 options 保持原语义，不引入无限增长的全局缓存。
const dateTimeFormatter = computed(() => createFormatter({ dateStyle: 'medium', timeStyle: 'short' }, DATETIME_FALLBACK));
const dateFormatter = computed(() => createFormatter({ dateStyle: 'medium' }, DATE_FALLBACK));
const timeFormatter = computed(() => createFormatter({ hour: '2-digit', minute: '2-digit' }, { hour: '2-digit', minute: '2-digit' }));

function formatWith(value, options, formatter) {
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return '';
  if (options !== undefined) {
    try {
      return createFormatter(options, DATETIME_FALLBACK).format(date);
    } catch (error) {
      return '';
    }
  }
  return formatter.value.format(date);
}

export function formatDateTime(value, options) {
  return formatWith(value, options, dateTimeFormatter);
}

export function formatDate(value, options) {
  return formatWith(value, options, dateFormatter);
}

export function formatTime(value, options) {
  return formatWith(value, options, timeFormatter);
}

export function compareLocalized(left, right) {
  return String(left).localeCompare(String(right), locale.value);
}

export function getLocale() {
  return locale.value;
}

export function useI18n() {
  return {
    locale: readonly(locale),
    localeLoading: readonly(localeLoading),
    isEnglish: computed(() => locale.value === ENGLISH_LOCALE),
    t,
    setLocale,
    formatDate,
    formatDateTime,
    formatTime,
    compareLocalized
  };
}
