import { ref } from "vue";

// 提示音用 WebAudio 现场合成，不依赖任何外部音频文件：
// 大陆网络下外链音频会拖慢首屏，且移动端自动播放策略对 <audio> 更严格。
export const MESSAGE_SOUND_STORAGE_KEY = "edgechat:message-sound";

const MIN_INTERVAL_MS = 700;
let sharedContext = null;

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

  function playMessageSound() {
    if (!soundEnabled.value) return false;
    const now = Date.now();
    // 群消息可能连发，做最短间隔限流，避免叠加成刺耳噪音。
    if (now - lastPlayedAt < MIN_INTERVAL_MS) return false;
    lastPlayedAt = now;

    const AudioContextCtor = resolveContext();
    if (!AudioContextCtor) return false;
    try {
      if (!sharedContext) sharedContext = new AudioContextCtor();
      const ctx = sharedContext;
      if (ctx.state === "suspended") void ctx.resume();
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
      return true;
    } catch {
      return false;
    }
  }

  return {
    soundEnabled,
    setSoundEnabled,
    toggleSound,
    playMessageSound,
  };
}
