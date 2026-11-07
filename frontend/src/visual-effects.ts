import { computed, ref } from 'vue';
import { onMediaQueryChange, safeMatchMedia } from './media-query.js';

const storageKey = 'edgechat.lowEffects';
const preference = ref(false);
const systemPreference = ref(false);

export const lowEffectsPreference = computed(() => preference.value);
export const systemLowEffects = computed(() => systemPreference.value);
export const lowEffects = computed(() => preference.value || systemPreference.value);

function apply() {
  document.documentElement.dataset.effects = lowEffects.value ? 'low' : 'full';
}

export function setLowEffectsPreference(value: boolean) {
  preference.value = value;
  apply();
  try {
    if (value) localStorage.setItem(storageKey, 'true');
    else localStorage.removeItem(storageKey);
  } catch {
    // 浏览器禁止存储时仍允许当前页面降级，偏好不应阻塞聊天。
  }
}

export function initVisualEffects() {
  // 显式传入 window，避免 SSR / 测试沙箱里 safeMatchMedia 取到错误的全局对象。
  const globalObject = typeof window !== 'undefined' ? window : undefined;
  const motion = safeMatchMedia('(prefers-reduced-motion: reduce)', globalObject);
  const transparency = safeMatchMedia('(prefers-reduced-transparency: reduce)', globalObject);
  try {
    preference.value = localStorage.getItem(storageKey) === 'true';
  } catch {
    preference.value = false;
  }

  function syncSystem() {
    // 系统无障碍偏好优先，取消手动低特效不会重新启用用户要求减少的效果。
    systemPreference.value = motion.matches || transparency.matches;
    apply();
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== storageKey && event.key !== null) return;
    // 只消费来自本站点 localStorage 的事件；禁用存储的浏览器里读取
    // localStorage 会抛错，此时跳过来源校验，仍允许按 key 同步。
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch (error) {
      // 存储不可访问：忽略 storageArea 校验，避免同步能力整体失效。
    }
    preference.value = event.newValue === 'true';
    apply();
  }

  const offMotion = onMediaQueryChange(motion, syncSystem);
  const offTransparency = onMediaQueryChange(transparency, syncSystem);
  window.addEventListener('storage', onStorage);
  syncSystem();

  return () => {
    offMotion();
    offTransparency();
    window.removeEventListener('storage', onStorage);
  };
}
