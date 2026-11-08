<script setup lang="ts">
import { ChevronRight, Menu, MessageCircle, Search, UsersRound, UserRoundCheck } from "@lucide/vue";
import { computed, onBeforeUnmount, toRef, watch } from "vue";
import type { UserSummary } from "../../../shared/user-profile.ts";
import UiAvatar from "../components/ui/Avatar.vue";
import UiButton from "../components/ui/Button.vue";
import { contactTimeValue, useContacts, type ContactConversation, type ContactEntry } from "../composables/useContacts.ts";
import { formatDate, formatTime, t } from "../i18n.js";

const props = withDefaults(defineProps<{
	visible: boolean;
	/** 聊天页已有的私信会话列表；通讯录据此只保留真正说过话的好友。 */
	conversations?: ContactConversation[];
}>(), { conversations: () => [] });

const emit = defineEmits<{
	openNavigation: [];
	openProfile: [user: UserSummary];
	unblocked: [userId: number];
}>();

const conversationsRef = toRef(props, "conversations");
const { query, view, loading, error, actionError, savingUserId, filteredUsers, load, selectView, unblock, dispose } =
	useContacts(undefined, { conversations: conversationsRef });

watch(() => props.visible, (visible) => { if (visible) void load(true); }, { immediate: true });
onBeforeUnmount(dispose);

type ContactGroup = { key: string; label: string; users: ContactEntry[] };

const groups = computed<ContactGroup[]>(() => {
	if (view.value === "blocked") {
		return [{ key: "blocked", label: "", users: filteredUsers.value }];
	}
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const todayMs = startOfToday.getTime();
	const today: ContactEntry[] = [];
	const yesterday: ContactEntry[] = [];
	const earlier: ContactEntry[] = [];
	for (const user of filteredUsers.value) {
		const stamp = contactTimeValue(user.lastMessageAt);
		if (!stamp || stamp >= todayMs) today.push(user);
		else if (stamp >= todayMs - 86400000) yesterday.push(user);
		else earlier.push(user);
	}
	return [
		{ key: "today", label: t("contacts.today"), users: today },
		{ key: "yesterday", label: t("contacts.yesterday"), users: yesterday },
		{ key: "earlier", label: t("contacts.earlier"), users: earlier },
	].filter((group) => group.users.length > 0);
});

const totalCount = computed(() => filteredUsers.value.length);

function lastTalkLabel(user: ContactEntry) {
	const stamp = contactTimeValue(user.lastMessageAt);
	if (!stamp) return "";
	const date = new Date(stamp);
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const time = date.getTime() >= startOfToday.getTime()
		? formatTime(date)
		: formatDate(date, { month: "short", day: "numeric" });
	return t("contacts.lastTalk", { time });
}

async function unblockContact(userId: number) {
	if (await unblock(userId)) emit("unblocked", userId);
}
</script>

<template>
  <main class="contacts-page">
    <header class="contacts-page__header">
      <div class="contacts-page__title-row">
        <button type="button" class="contacts-page__menu" :aria-label="t('nav.openNavigation')" @click="emit('openNavigation')">
          <Menu :size="22" aria-hidden="true" />
        </button>
        <div class="contacts-page__heading">
          <h1>{{ t('contacts.title') }}</h1>
          <p class="contacts-page__hint">{{ t('contacts.recentHint') }}</p>
        </div>
        <span v-if="!loading && !error && view === 'all'" class="contacts-page__count">{{ t('contacts.peopleCount', { count: totalCount }) }}</span>
      </div>

      <div class="contacts-page__controls">
        <div class="contacts-page__filters" role="group" :aria-label="t('contacts.title')">
          <button type="button" :aria-pressed="view === 'all'" :disabled="savingUserId !== null" @click="selectView('all')">
            <MessageCircle :size="16" aria-hidden="true" />
            {{ t('contacts.recent') }}
          </button>
          <button type="button" :aria-pressed="view === 'blocked'" :disabled="savingUserId !== null" @click="selectView('blocked')">
            {{ t('contacts.blocked') }}
          </button>
        </div>
        <label class="contacts-page__search">
          <Search :size="18" aria-hidden="true" />
          <span class="sr-only">{{ t('contacts.search') }}</span>
          <input v-model="query" type="search" :placeholder="t('contacts.search')" autocomplete="off" />
        </label>
      </div>
    </header>

    <section class="contacts-page__body" :aria-busy="loading">
      <p v-if="actionError" class="contacts-page__error" role="alert">{{ actionError }}</p>
      <div v-if="loading" class="contacts-page__skeleton" role="status">
        <span class="sr-only">{{ t('contacts.loading') }}</span>
        <div v-for="n in 4" :key="n" class="contacts-page__skeleton-row">
          <span class="contacts-page__skeleton-avatar"></span>
          <span class="contacts-page__skeleton-lines"><i></i><i></i></span>
        </div>
      </div>
      <div v-else-if="error" class="contacts-page__state" role="alert">
        <span class="contacts-page__state-icon"><UsersRound :size="30" aria-hidden="true" /></span>
        <p>{{ t('contacts.loadFailed') }}</p>
        <UiButton variant="secondary" @click="load(true)">{{ t('common.retry') }}</UiButton>
      </div>
      <div v-else-if="!groups.length" class="contacts-page__state" role="status">
        <span class="contacts-page__state-icon"><UsersRound :size="30" aria-hidden="true" /></span>
        <p>{{ query.trim() ? t('contacts.noResults') : t(view === 'blocked' ? 'contacts.blockedEmpty' : 'contacts.emptyRecent') }}</p>
      </div>
      <template v-else>
        <section v-for="group in groups" :key="group.key" class="contacts-page__group">
          <h2 v-if="group.label" class="contacts-page__group-label">{{ group.label }}<span>{{ group.users.length }}</span></h2>
          <ul class="contacts-page__list" :aria-label="t(view === 'blocked' ? 'contacts.blocked' : 'contacts.recentList')">
            <li v-for="user in group.users" :key="user.id" class="contacts-page__item">
              <button
                type="button"
                class="contacts-page__row"
                :aria-label="t('profile.view', { name: user.displayName || user.username })"
                @click="emit('openProfile', user)"
              >
                <span class="contacts-page__avatar-wrap">
                  <UiAvatar :src="user.avatarUrl" :fallback="user.displayName || user.username" size="md" />
                  <span v-if="user.unreadCount" class="contacts-page__dot" aria-hidden="true"></span>
                </span>
                <span class="contacts-page__identity">
                  <span>{{ user.displayName || user.username }}</span>
                  <span v-if="lastTalkLabel(user)" class="contacts-page__meta">{{ lastTalkLabel(user) }}</span>
                </span>
                <span v-if="user.unreadCount" class="contacts-page__unread">{{ user.unreadCount > 99 ? '99+' : user.unreadCount }}</span>
                <ChevronRight v-if="view !== 'blocked'" :size="17" class="contacts-page__chevron" aria-hidden="true" />
              </button>
              <button
                v-if="view === 'blocked'"
                type="button"
                class="contacts-page__unblock"
                :disabled="savingUserId !== null"
                :aria-label="t('contacts.unblockNamed', { name: user.displayName || user.username })"
                :aria-busy="savingUserId === user.id"
                @click="unblockContact(user.id)"
              >
                <span v-if="savingUserId === user.id" class="contacts-page__spinner contacts-page__spinner--small" aria-hidden="true"></span>
                <UserRoundCheck v-else :size="18" aria-hidden="true" />
                <span>{{ t('chat.unblock') }}</span>
              </button>
            </li>
          </ul>
        </section>
      </template>
    </section>
  </main>
</template>

<style scoped>
.contacts-page {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--chat-paper);
  color: var(--chat-ink);
}

.contacts-page__header {
  display: grid;
  gap: 18px;
  padding: 26px clamp(20px, 5vw, 64px) 22px;
  border-bottom: 1px solid var(--chat-line);
  background: var(--chat-paper);
}

.contacts-page__title-row { display: flex; align-items: center; gap: 10px; }
.contacts-page__heading { min-width: 0; }
.contacts-page__title-row h1 { margin: 0; font-size: 25px; font-weight: 680; letter-spacing: -0.02em; line-height: 1.25; }
.contacts-page__hint { margin: 4px 0 0; color: var(--chat-muted); font-size: 13px; line-height: 1.5; }
.contacts-page__count {
  margin-left: auto;
  flex: 0 0 auto;
  padding: 5px 11px;
  border: 1px solid var(--chat-line);
  border-radius: 999px;
  background: var(--chat-hover);
  color: var(--chat-muted);
  font-size: 12px;
  white-space: nowrap;
}

.contacts-page__menu {
  display: none;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--chat-muted);
}

.contacts-page__controls { display: grid; gap: 12px; }
.contacts-page__filters {
  display: inline-flex;
  width: fit-content;
  max-width: 100%;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--chat-line);
  border-radius: 12px;
  background: var(--chat-hover);
}
.contacts-page__filters button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--chat-muted);
  font: inherit;
  font-size: 13.5px;
  font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
  transition: background 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
.contacts-page__filters button[aria-pressed="true"] {
  border-color: var(--chat-line);
  background: var(--chat-paper);
  color: var(--chat-accent);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.07);
}
.contacts-page__filters button:hover:not([aria-pressed="true"]) { color: var(--chat-ink); }
.contacts-page__filters button:focus-visible, .contacts-page__unblock:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; }
.contacts-page__filters button:disabled, .contacts-page__unblock:disabled { opacity: 0.6; cursor: wait; }

.contacts-page__search {
  display: flex;
  align-items: center;
  width: min(100%, 620px);
  height: 46px;
  gap: 10px;
  padding: 0 15px;
  border: 1px solid var(--chat-line);
  border-radius: 23px;
  background: var(--chat-hover);
  color: var(--chat-muted);
  transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
}
.contacts-page__search:focus-within { border-color: var(--chat-accent); background: var(--chat-paper); box-shadow: 0 0 0 3px rgba(var(--site-brand-rgb, 0, 128, 105), 0.14); }
.contacts-page__search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--chat-ink); font: inherit; letter-spacing: 0; }

.contacts-page__body {
  width: min(100%, 760px);
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 6px clamp(12px, 5vw, 64px) calc(24px + env(safe-area-inset-bottom));
}

.contacts-page__group + .contacts-page__group { margin-top: 14px; }
.contacts-page__group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 10px 8px;
  color: var(--chat-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.contacts-page__group-label span {
  display: inline-grid;
  min-width: 20px;
  height: 18px;
  place-items: center;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--chat-hover);
  font-size: 11px;
  letter-spacing: 0;
}

.contacts-page__list { margin: 0; padding: 0; list-style: none; }
.contacts-page__item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  border-radius: 14px;
}
.contacts-page__item + .contacts-page__item { border-top: 1px solid var(--chat-hover); }

.contacts-page__row {
  display: flex;
  width: 100%;
  min-width: 0;
  flex: 1;
  min-height: 80px;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--chat-ink);
  cursor: pointer;
  text-align: left;
  touch-action: manipulation;
  transition: background 160ms ease, transform 160ms ease;
}
.contacts-page__row:hover { background: var(--chat-hover); }
.contacts-page__row:active { background: var(--chat-selected); transform: scale(0.995); }
.contacts-page__row:focus-visible, .contacts-page__menu:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; }

.contacts-page__avatar-wrap { position: relative; flex: 0 0 auto; line-height: 0; }
.contacts-page__avatar-wrap .ui-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--chat-paper), 0 0 0 3px var(--chat-line);
}
.contacts-page__dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 11px;
  height: 11px;
  border: 2px solid var(--chat-paper);
  border-radius: 50%;
  background: var(--chat-accent);
}

.contacts-page__identity { display: grid; min-width: 0; flex: 1; gap: 3px; }
.contacts-page__identity > span:first-child {
  min-width: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.contacts-page__meta {
  min-width: 0;
  overflow: hidden;
  color: var(--chat-muted);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.contacts-page__unread {
  display: inline-grid;
  min-width: 22px;
  height: 22px;
  flex: 0 0 auto;
  place-items: center;
  padding: 0 6px;
  border-radius: 11px;
  background: var(--chat-accent);
  color: #fff;
  font-size: 11.5px;
  font-weight: 650;
}
.contacts-page__chevron { flex: 0 0 auto; color: var(--chat-muted); opacity: 0.55; }

.contacts-page__unblock { display: inline-flex; flex: 0 0 auto; min-height: 44px; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: var(--chat-accent); font: inherit; font-size: 14px; cursor: pointer; white-space: nowrap; }
.contacts-page__unblock:hover { background: var(--chat-hover); }
.contacts-page__error { color: var(--chat-danger); font-size: 14px; }

.contacts-page__state {
  display: grid;
  min-height: 240px;
  place-items: center;
  align-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--chat-muted);
  text-align: center;
}
.contacts-page__state-icon {
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border-radius: 50%;
  background: var(--chat-hover);
  color: var(--chat-accent);
}
.contacts-page__state p { margin: 0; max-width: 320px; line-height: 1.6; }

.contacts-page__skeleton { display: grid; gap: 6px; padding-top: 14px; }
.contacts-page__skeleton-row { display: flex; align-items: center; gap: 14px; min-height: 80px; padding: 12px 14px; }
.contacts-page__skeleton-avatar, .contacts-page__skeleton-lines i {
  display: block;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--chat-hover) 25%, var(--chat-selected) 50%, var(--chat-hover) 75%);
  background-size: 200% 100%;
  animation: contacts-shimmer 1.4s ease-in-out infinite;
}
.contacts-page__skeleton-avatar { width: 48px; height: 48px; flex: 0 0 48px; border-radius: 50%; }
.contacts-page__skeleton-lines { display: grid; flex: 1; gap: 8px; }
.contacts-page__skeleton-lines i { height: 11px; }
.contacts-page__skeleton-lines i:first-child { width: 38%; }
.contacts-page__skeleton-lines i:last-child { width: 22%; opacity: 0.6; }
@keyframes contacts-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.contacts-page__spinner { width: 26px; height: 26px; border: 2px solid var(--chat-line); border-top-color: var(--chat-accent); border-radius: 50%; animation: contacts-spin 700ms linear infinite; }
.contacts-page__spinner--small { width: 18px; height: 18px; }
@keyframes contacts-spin { to { transform: rotate(360deg); } }

@media (max-width: 960px) {
  .contacts-page__header {
    gap: 12px;
    padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 14px max(12px, env(safe-area-inset-left));
  }
  .contacts-page__menu { display: grid; }
  .contacts-page__title-row h1 { font-size: 21px; }
  .contacts-page__hint { font-size: 12px; }
  .contacts-page__search { width: 100%; }
  .contacts-page__filters { width: 100%; }
  .contacts-page__filters button { flex: 1; padding: 0 10px; }
  .contacts-page__body { width: 100%; padding-right: max(8px, env(safe-area-inset-right)); padding-left: max(8px, env(safe-area-inset-left)); scrollbar-gutter: auto; }
}

@media (prefers-reduced-motion: reduce) {
  .contacts-page__spinner, .contacts-page__skeleton-avatar, .contacts-page__skeleton-lines i { animation: none; }
  .contacts-page__row { transition: none; }
}
</style>
