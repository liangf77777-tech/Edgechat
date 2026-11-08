import { computed, ref, type Ref } from "vue";
import type { UserSummary } from "../../../shared/user-profile.ts";
import api from "../api.js";

type ContactsApi = {
	getContacts: (options?: { signal?: AbortSignal }) => Promise<{ users: UserSummary[] }>;
	getBlockedUsers: (options?: { signal?: AbortSignal }) => Promise<{ users: UserSummary[] }>;
	unblockUser: (userId: number) => Promise<{ blockedByMe: boolean }>;
};

/** 会话列表里只需要「对端 + 最后一条消息时间 + 未读数」这三样信息。 */
export type ContactConversation = {
	otherUser?: { id: number | string } | null;
	lastMessageAt?: string | null;
	unreadCount?: number | string | null;
};

export type ContactEntry = UserSummary & {
	lastMessageAt?: string;
	unreadCount?: number;
};

type UseContactsOptions = {
	/** 传入时「全部」视图只保留真正聊过天的好友；不传时保持完整目录语义。 */
	conversations?: Ref<ContactConversation[]>;
};

// D1 的 CURRENT_TIMESTAMP 是 UTC 但没有时区标记，直接 Date.parse 会得到 NaN。
export function contactTimeValue(value?: string | null): number {
	if (!value) return 0;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function useContacts(contactsApi: ContactsApi = api, options: UseContactsOptions = {}) {
	const users = ref<UserSummary[]>([]);
	const query = ref("");
	const view = ref<"all" | "blocked">("all");
	const loading = ref(false);
	const error = ref("");
	const actionError = ref("");
	const savingUserId = ref<number | null>(null);
	let loaded = false;
	let generation = 0;
	let controller: AbortController | null = null;
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

	const sortedUsers = computed(() =>
		[...users.value].sort((left, right) => {
			const leftName = left.displayName || left.username;
			const rightName = right.displayName || right.username;
			return collator.compare(leftName, rightName)
				|| collator.compare(left.username, right.username)
				|| left.id - right.id;
		}),
	);

	// 「说过话」的判据是 DM 里存在至少一条未删除的消息（lastMessageAt 非空）。
	// 仅仅 openDm 建过会话、但一句话都没发过的人不算好友。
	const talkedUsers = computed<ContactEntry[]>(() => {
		const conversations = options.conversations?.value;
		if (!conversations) return sortedUsers.value;
		const activity = new Map<number, { lastMessageAt: string; unreadCount: number }>();
		for (const conversation of conversations) {
			const at = conversation?.lastMessageAt;
			if (!at) continue;
			const id = Number(conversation?.otherUser?.id);
			if (!Number.isFinite(id) || activity.has(id)) continue;
			activity.set(id, {
				lastMessageAt: String(at),
				unreadCount: Math.max(0, Number(conversation?.unreadCount || 0) || 0),
			});
		}
		return users.value
			.filter((user) => activity.has(Number(user.id)))
			.map((user) => ({ ...user, ...activity.get(Number(user.id)) }))
			.sort((left, right) =>
				contactTimeValue(right.lastMessageAt) - contactTimeValue(left.lastMessageAt)
				|| collator.compare(left.displayName || left.username, right.displayName || right.username)
				|| left.id - right.id,
			);
	});

	const filteredUsers = computed<ContactEntry[]>(() => {
		// 拉黑视图是独立名单，不受「有没有聊过天」影响。
		const base = view.value === "blocked" ? sortedUsers.value : talkedUsers.value;
		const needle = query.value.trim().toLocaleLowerCase();
		if (!needle) return base;
		return base.filter((user) =>
			[user.displayName, user.username].some((value) =>
				String(value || "").toLocaleLowerCase().includes(needle),
			),
		);
	});

	async function load(force = false) {
		if (savingUserId.value !== null) return;
		if (!force && (loading.value || loaded)) return;
		controller?.abort();
		controller = new AbortController();
		const request = ++generation;
		loading.value = true;
		error.value = "";
		try {
			const payload = view.value === "blocked"
				? await contactsApi.getBlockedUsers({ signal: controller.signal })
				: await contactsApi.getContacts({ signal: controller.signal });
			if (request !== generation) return;
			users.value = payload.users;
			loaded = true;
		} catch (cause) {
			if (request !== generation) return;
			error.value = (cause as Error).message;
		} finally {
			if (request === generation) loading.value = false;
		}
	}

	async function selectView(next: "all" | "blocked") {
		if (next === view.value || savingUserId.value !== null) return;
		view.value = next;
		actionError.value = "";
		await load(true);
	}

	async function unblock(userId: number) {
		if (savingUserId.value !== null) return false;
		savingUserId.value = userId;
		actionError.value = "";
		try {
			await contactsApi.unblockUser(userId);
			users.value = users.value.filter((user) => user.id !== userId);
			return true;
		} catch (cause) {
			actionError.value = (cause as Error).message;
			return false;
		} finally {
			savingUserId.value = null;
		}
	}

	function dispose() {
		generation += 1;
		controller?.abort();
		controller = null;
	}

	return { users, query, view, loading, error, actionError, savingUserId, filteredUsers, load, selectView, unblock, dispose };
}
