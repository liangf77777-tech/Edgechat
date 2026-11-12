<script setup>
import { ref, toRef, watch } from 'vue';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { t } from '../../i18n.js';
import api from '../../api.js';
import UiAvatar from '../ui/Avatar.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  users: { type: Array, default: () => [] },
  openingDmUserId: { type: Number, default: null },
  error: { type: String, default: '' },
  isAdmin: { type: Boolean, default: false }
});

const emit = defineEmits(['close', 'create-group', 'open-dm']);
const step = ref('choose');
const firstActionEl = ref(null);
const usernameQuery = ref('');
const usernameResults = ref([]);
const usernameError = ref('');
const searching = ref(false);
let searchSequence = 0;

useOverlayLifecycle({
  open: toRef(props, 'show'),
  onClose: () => emit('close'),
  focusTarget: firstActionEl
});

watch(
  () => props.show,
  (show) => {
    // 普通用户只有「按用户名添加好友」一个入口，打开时直接进入该步骤。
    step.value = show && !props.isAdmin ? 'username' : 'choose';
    if (!show) resetUsernameSearch();
  }
);

watch(
  () => props.isAdmin,
  (isAdmin) => {
    if (!isAdmin && step.value === 'dm') step.value = 'username';
  }
);

function resetUsernameSearch() {
  searchSequence += 1;
  usernameQuery.value = '';
  usernameResults.value = [];
  usernameError.value = '';
  searching.value = false;
}

async function searchByUsername() {
  const query = usernameQuery.value.trim();
  if (!query || searching.value) return;
  const sequence = ++searchSequence;
  searching.value = true;
  usernameError.value = '';
  try {
    const payload = await api.searchContacts(query);
    if (sequence !== searchSequence || !props.show) return;
    usernameResults.value = Array.isArray(payload?.users) ? payload.users : [];
    if (!usernameResults.value.length) {
      usernameError.value = t('conversation.usernameNotFound');
    }
  } catch (currentError) {
    if (sequence !== searchSequence || !props.show) return;
    usernameResults.value = [];
    usernameError.value = currentError?.message || t('conversation.searchFailed');
  } finally {
    if (sequence === searchSequence) searching.value = false;
  }
}

function openDmWith(user) {
  usernameError.value = '';
  emit('open-dm', user);
}

function stepHint() {
  if (step.value === 'dm') return t('conversation.chooseContact');
  if (step.value === 'username') return t('conversation.addByUsernameDescription');
  return t('conversation.chooseType');
}
</script>

<template>
  <Transition name="add-conversation-fade">
    <div
      v-if="show"
      class="add-conversation-overlay"
      @click.self="emit('close')"
    >
      <section
        class="add-conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-conversation-title"
      >
        <header class="add-conversation-dialog__header">
          <div>
            <h2 id="add-conversation-title">{{ t('chat.addPeople') }}</h2>
            <p>{{ stepHint() }}</p>
          </div>
          <button type="button" class="add-conversation-dialog__close" :aria-label="t('common.close')" @click="emit('close')">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <title>{{ t('common.close') }}</title>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div v-if="step === 'choose'" class="add-conversation-dialog__choices">
          <button ref="firstActionEl" type="button" class="add-conversation-choice" @click="step = 'username'">
            <span class="add-conversation-choice__icon">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8">
                <title>{{ t('conversation.addByUsername') }}</title>
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
                <path d="M19 8v6M16 11h6" />
              </svg>
            </span>
            <span>
              <strong>{{ t('conversation.addByUsername') }}</strong>
              <small>{{ t('conversation.addByUsernameDescription') }}</small>
            </span>
            <svg class="add-conversation-choice__arrow" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <title>{{ t('conversation.addByUsername') }}</title>
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>

          <button v-if="isAdmin" type="button" class="add-conversation-choice" @click="step = 'dm'">
            <span class="add-conversation-choice__icon">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8">
                <title>{{ t('conversation.startNew') }}</title>
                <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
              </svg>
            </span>
            <span>
              <strong>{{ t('conversation.startNew') }}</strong>
              <small>{{ t('conversation.startNewDescription') }}</small>
            </span>
            <svg class="add-conversation-choice__arrow" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <title>{{ t('conversation.chooseContacts') }}</title>
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>

          <button v-if="isAdmin" type="button" class="add-conversation-choice" @click="emit('create-group')">
            <span class="add-conversation-choice__icon">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8">
                <title>{{ t('conversation.createGroup') }}</title>
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="8.5" cy="7" r="4" />
                <path d="M20 8v6M23 11h-6" />
              </svg>
            </span>
            <span>
              <strong>{{ t('conversation.createGroup') }}</strong>
              <small>{{ t('conversation.createGroupDescription') }}</small>
            </span>
            <svg class="add-conversation-choice__arrow" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <title>{{ t('conversation.enterGroupCreation') }}</title>
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>

        <div v-else-if="step === 'username'" class="add-conversation-dialog__people">
          <button v-if="isAdmin" type="button" class="add-conversation-dialog__back" @click="step = 'choose'">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <title>{{ t('common.back') }}</title>
              <path d="m15 18-6-6 6-6" />
            </svg>
            {{ t('common.back') }}
          </button>

          <form class="add-conversation-dialog__search" @submit.prevent="searchByUsername">
            <input
              v-model="usernameQuery"
              type="text"
              name="username"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              maxlength="64"
              :placeholder="t('conversation.usernamePlaceholder')"
              :aria-label="t('conversation.usernamePlaceholder')"
            />
            <button type="submit" :disabled="!usernameQuery.trim() || searching">
              {{ searching ? t('conversation.searching') : t('conversation.search') }}
            </button>
          </form>

          <p v-if="usernameError" class="add-conversation-dialog__error" role="alert">{{ usernameError }}</p>
          <p v-else-if="!usernameResults.length && !searching" class="add-conversation-dialog__hint">
            {{ t('conversation.usernameSearchHint') }}
          </p>

          <div v-if="usernameResults.length" class="add-conversation-dialog__list">
            <button
              v-for="user in usernameResults"
              :key="user.id"
              type="button"
              class="add-conversation-person"
              :disabled="openingDmUserId !== null"
              @click="openDmWith(user)"
            >
              <UiAvatar :src="user.avatarUrl" :fallback="user.displayName?.[0] || '?'" size="sm" />
              <span class="add-conversation-person__identity">
                <strong>{{ user.displayName }}</strong>
                <small>@{{ user.username }}</small>
              </span>
              <span class="add-conversation-person__status" aria-live="polite">
                {{ openingDmUserId === Number(user.id) ? t('common.opening') : t('conversation.add') }}
              </span>
            </button>
          </div>
        </div>

        <div v-else class="add-conversation-dialog__people">
          <button type="button" class="add-conversation-dialog__back" @click="step = 'choose'">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <title>{{ t('common.back') }}</title>
              <path d="m15 18-6-6 6-6" />
            </svg>
            {{ t('common.back') }}
          </button>

          <p v-if="error" class="add-conversation-dialog__error" role="alert">{{ error }}</p>
          <p v-if="!users.length" class="add-conversation-dialog__empty">
            {{ t('conversation.allUsersHaveDm') }}
          </p>

          <div v-else class="add-conversation-dialog__list">
            <button
              v-for="user in users"
              :key="user.id"
              type="button"
              class="add-conversation-person"
              :disabled="openingDmUserId !== null"
              @click="emit('open-dm', user)"
            >
              <UiAvatar :src="user.avatarUrl" :fallback="user.displayName?.[0] || '?'" size="sm" />
              <span class="add-conversation-person__identity">
                <strong>{{ user.displayName }}</strong>
                <small>@{{ user.username }}</small>
              </span>
              <span class="add-conversation-person__status" aria-live="polite">
                {{ openingDmUserId === Number(user.id) ? t('common.opening') : t('conversation.start') }}
              </span>
            </button>
          </div>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.add-conversation-overlay {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  align-items: center;
  justify-content: center;
  padding:
    max(16px, env(safe-area-inset-top))
    max(16px, env(safe-area-inset-right))
    max(16px, env(safe-area-inset-bottom))
    max(16px, env(safe-area-inset-left));
  background: rgba(0, 0, 0, 0.4);
}

.add-conversation-dialog {
  width: min(440px, 100%);
  max-height: min(620px, calc(100dvh - 32px));
  overflow: hidden;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
}

.add-conversation-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 24px 16px;
}

.add-conversation-dialog__header h2 {
  margin: 0;
  color: #111b21;
  font-size: 18px;
}

.add-conversation-dialog__header p {
  margin: 6px 0 0;
  color: #667781;
  font-size: 13px;
}

.add-conversation-dialog__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  margin: -10px -10px 0 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #54656f;
  cursor: pointer;
  transition: background 150ms, color 150ms;
}

.add-conversation-dialog__close:hover {
  background: #f0f2f5;
  color: #111b21;
}

.add-conversation-dialog__choices,
.add-conversation-dialog__people {
  display: grid;
  gap: 12px;
  padding: 8px 24px 24px;
}

.add-conversation-choice,
.add-conversation-person {
  width: 100%;
  min-height: 64px;
  border: 1px solid #e8ecf0;
  border-radius: 12px;
  background: #fff;
  color: #111b21;
  cursor: pointer;
  transition: background 150ms, border-color 150ms, box-shadow 150ms;
}

.add-conversation-choice {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  text-align: left;
}

.add-conversation-choice:hover,
.add-conversation-person:hover:not(:disabled) {
  border-color: var(--site-brand, #b7d8d2);
  background: var(--site-selected, #f5fbf9);
  box-shadow: 0 4px 14px rgba(var(--site-brand-rgb, 0, 128, 105), 0.08);
}

.add-conversation-choice__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--site-selected, #e7f4f1);
  color: var(--site-brand, #008069);
}

.add-conversation-choice span:nth-child(2) {
  display: grid;
  gap: 4px;
}

.add-conversation-choice strong,
.add-conversation-person strong {
  font-size: 14px;
  font-weight: 600;
}

.add-conversation-choice small,
.add-conversation-person small {
  color: #667781;
  font-size: 12px;
}

.add-conversation-choice__arrow {
  color: #8696a0;
}

.add-conversation-dialog__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--site-brand, #008069);
  cursor: pointer;
}

.add-conversation-dialog__back:hover {
  background: #f0f2f5;
}

.add-conversation-dialog__search {
  display: flex;
  gap: 8px;
}

.add-conversation-dialog__search input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid #d9e1e6;
  border-radius: 10px;
  background: #f7f9fa;
  color: #111b21;
  font: inherit;
  font-size: 14px;
}

.add-conversation-dialog__search input:focus-visible {
  outline: 2px solid var(--site-brand, #008069);
  outline-offset: 1px;
}

.add-conversation-dialog__search button {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  background: var(--site-brand, #008069);
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.add-conversation-dialog__search button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.add-conversation-dialog__list {
  display: grid;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
}

.add-conversation-person {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  text-align: left;
}

.add-conversation-person:disabled {
  cursor: wait;
  opacity: 0.58;
}

.add-conversation-person__identity {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.add-conversation-person__identity strong,
.add-conversation-person__identity small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-conversation-person__status {
  color: var(--site-brand, #008069);
  font-size: 12px;
  font-weight: 600;
}

.add-conversation-dialog__empty,
.add-conversation-dialog__error,
.add-conversation-dialog__hint {
  margin: 0;
  padding: 14px 16px;
  border-radius: 10px;
  font-size: 13px;
}

.add-conversation-dialog__empty,
.add-conversation-dialog__hint {
  background: #f5f7fa;
  color: #667781;
}

.add-conversation-dialog__error {
  background: #fef2f2;
  color: #b91c1c;
}

.add-conversation-dialog button:focus-visible {
  outline: 3px solid rgba(var(--site-brand-rgb, 0, 128, 105), 0.24);
  outline-offset: 2px;
}

.add-conversation-fade-enter-active {
  transition: opacity 200ms ease-out;
}

.add-conversation-fade-leave-active {
  transition: opacity 150ms ease-in;
}

.add-conversation-fade-enter-from,
.add-conversation-fade-leave-to {
  opacity: 0;
}

@media (max-width: 480px) {
  .add-conversation-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .add-conversation-dialog {
    width: 100%;
    max-height: calc(100dvh - env(safe-area-inset-top));
    border-radius: 16px 16px 0 0;
  }

  .add-conversation-dialog__header,
  .add-conversation-dialog__choices,
  .add-conversation-dialog__people {
    padding-left: 16px;
    padding-right: 16px;
  }

  .add-conversation-dialog__people {
    min-height: 0;
  }

  .add-conversation-dialog__list {
    max-height: min(50dvh, 360px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .add-conversation-fade-enter-active {
    transition: none;
  }

  .add-conversation-fade-leave-active {
    transition: none;
  }
}
</style>
