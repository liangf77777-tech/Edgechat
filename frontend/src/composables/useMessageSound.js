import { ref } from "vue";

// 提示音用 WebAudio 现场合成，不依赖任何外部音频文件：
// 大陆网络下外链音频会拖慢首屏，且移动端自动播放策略对 <audio> 更严格。
export const MESSAGE_SOUND_STORAGE_KEY = "edgechat:message-sound";

const MIN_INTERVAL_MS = 700;
let sharedContext = null;
let sharedContextFactory = null;

function readEnabled(storage) {
  try {
    return storage?.getItem(MESSAGE_SOUND_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function useMessageSound(options = {}) {
  const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
  const resolveContext = options.audioContextFactory === undefined
    ? () => globalThis.AudioContext || globalThis.webkitAudioContext
    : options.audioContextFactory;
  const soundEnabled = ref(readEnabled(storage));
  let lastPlayedAt = 0;

  function setSoundEnabled(value) {
    soundEnabled.value = Boolean(value);
    try {
      storage?.setItem(MESSAGE_SOUND_STORAGE_KEY, soundEnabled.value ? "on" : "off");
    } catch {
      // 隐私模式下 localStorage 不可用，仅保留内存状态。
    }
    return soundEnabled.value;
  }

  function toggleSound() {
    return setSoundEnabled(!soundEnabled.value);
  }

  function ensureContext() {
    const AudioContextCtor = resolveContext();
    if (!AudioContextCtor) return null;
    try {
      // 注入不同构造器（测试/多运行时）时重建，避免复用一个已失效的上下文。
      if (!sharedContext || sharedContextFactory !== AudioContextCtor) {
        sharedContext = new AudioContextCtor();
        sharedContextFactory = AudioContextCtor;
      }
      return sharedContext;
    } catch {
      return null;
    }
  }

  function emitTone(ctx) {
    const start = ctx.currentTime + 0.005;
    // 两声轻快的上行正弦音，总时长约 0.21s，音量克制。
    [0, 0.105].forEach((offset, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = index === 0 ? 880 : 1174.66;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.11, start + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.09);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.1);
    });
  }

  // 浏览器/iOS WebView 要求 AudioContext 在用户手势里创建并 resume。
  // 页面加载时在 pointerdown/keydown 上调一次，之后 WS 回调里就能正常出声。
  async function unlockMessageSound() {
    const ctx = ensureContext();
    if (!ctx) return false;
    if (ctx.state === "running") return true;
    try {
      await Promise.resolve(ctx.resume());
    } catch {
      return false;
    }
    return ctx.state === "running";
  }

  function playMessageSound() {
    if (!soundEnabled.value) return false;
    const now = Date.now();
    // 群消息可能连发，做最短间隔限流，避免叠加成刺耳噪音。
    if (now - lastPlayedAt < MIN_INTERVAL_MS) return false;
    lastPlayedAt = now;

    const ctx = ensureContext();
    if (!ctx) return false;
    if (ctx.state === "running") {
      try {
        emitTone(ctx);
        return true;
      } catch {
        return false;
      }
    }
    // suspended / interrupted 状态下 currentTime 不推进，直接排程等于排在过去，
    // 声音永远不会播出：先 resume，等状态真正 running 再排振荡器。
    Promise.resolve()
      .then(() => ctx.resume())
      .then(() => {
        if (ctx.state === "running") emitTone(ctx);
      })
      .catch(() => {});
    return true;
  }

  return {
    soundEnabled,
    setSoundEnabled,
    toggleSound,
    playMessageSound,
    unlockMessageSound,
  };
}
