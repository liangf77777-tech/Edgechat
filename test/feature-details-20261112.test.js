import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";

import { createD1Adapter } from "./support/d1.js";
import {
	getContactAlias,
	listContacts,
	searchContactsByUsername,
	setContactAlias,
} from "../worker/src/data/users.js";
import { recallMessage } from "../worker/src/data/messages.js";
import {
	createMessageRecall,
	MessageRecallError,
} from "../worker/src/message-recall.js";
import { isSiteAdminPrincipal } from "../worker/src/room-access.js";
import {
	MESSAGE_SOUND_STORAGE_KEY,
	useMessageSound,
} from "../frontend/src/composables/useMessageSound.js";

const SQL = await initSqlJs();
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function harness() {
	const database = new SQL.Database();
	database.exec(schema);
	database.run(
		`INSERT INTO users (id, username, display_name, password_hash, password_salt)
		 VALUES (1, 'self', 'Self', 'h', 's'),
		        (2, 'alice', 'Alice', 'h', 's'),
		        (3, 'alice2', 'Alice Two', 'h', 's'),
		        (4, 'bob', 'Bob', 'h', 's')`,
	);
	return { database, db: createD1Adapter(database) };
}

test("管理员标识在 WS/REST 两种命名下都归一", () => {
	assert.equal(isSiteAdminPrincipal({ isAdmin: true }), true);
	assert.equal(isSiteAdminPrincipal({ isSuperAdmin: true }), true);
	assert.equal(isSiteAdminPrincipal({ isAdmin: false, isSuperAdmin: false }), false);
	assert.equal(isSiteAdminPrincipal(null), false);
});

test("按用户名精确查找好友并排除自己", async () => {
	const { db } = harness();
	const found = await searchContactsByUsername(db, { query: "alice", excludeUserId: 1 });
	assert.deepEqual(found.map((user) => user.id), [2]);
	assert.equal(found[0].alias, "");
});

test("用户名前缀查找排除禁用/删除/本人", async () => {
	const { db, database } = harness();
	database.run("UPDATE users SET is_disabled = 1 WHERE id = 3");
	database.run("UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 4");
	const found = await searchContactsByUsername(db, { query: "ali", excludeUserId: 1 });
	assert.deepEqual(found.map((user) => user.id), [2]);
	assert.equal(found.some((user) => Number(user.id) === 1), false);
	assert.deepEqual(await searchContactsByUsername(db, { query: "", excludeUserId: 1 }), []);
});

test("好友备注按我的视角存储、可清除且长度受限", async () => {
	const { db } = harness();
	assert.equal(await setContactAlias(db, 1, 2, "  小明  "), "小明");
	assert.equal(await getContactAlias(db, 1, 2), "小明");
	assert.equal(await getContactAlias(db, 2, 1), "", "对方看不到我的备注");
	assert.equal((await listContacts(db, 1)).find((user) => Number(user.id) === 2).alias, "小明");
	assert.equal((await listContacts(db, 2)).find((user) => Number(user.id) === 1).alias, "");
	assert.equal(await setContactAlias(db, 1, 2, ""), "");
	assert.equal((await listContacts(db, 1)).find((user) => Number(user.id) === 2).alias, "");
	assert.equal((await setContactAlias(db, 1, 2, "x".repeat(50))).length, 32);
});

test("撤回只生效一次且保留占位行", async () => {
	const { db, database } = harness();
	database.run("INSERT INTO channels (id, name, kind, dm_key) VALUES (10, 'dm:1:2', 'dm', '1:2')");
	database.run("INSERT INTO messages (id, channel_id, sender_id, content) VALUES (50, 10, 2, 'secret')");
	assert.equal(await recallMessage(db, { channelId: 10, messageId: 50, recalledBy: 1 }), true);
	assert.equal(await recallMessage(db, { channelId: 10, messageId: 50, recalledBy: 1 }), false);
	const row = database.exec("SELECT recalled_at, recalled_by FROM messages WHERE id = 50")[0].values[0];
	assert.ok(row[0]);
	assert.equal(Number(row[1]), 1);
});

test("撤回动作仅管理员可执行并广播 message_recalled", async () => {
	const recall = createMessageRecall({
		authorize: async () => ({ ok: true, identity: { userId: 9 } }),
		persistRecall: async () => true,
	});
	const meta = { principal: { isAdmin: true }, room: { kind: "dm", id: 5 } };
	const result = await recall({}, meta, { messageId: 12 });
	assert.equal(result.messageId, 12);
	assert.equal(JSON.parse(result.packet).type, "message_recalled");

	const denied = createMessageRecall({
		authorize: async () => ({ ok: false }),
		persistRecall: async () => true,
	});
	await assert.rejects(denied({}, meta, { messageId: 12 }), MessageRecallError);
	await assert.rejects(recall({}, meta, { messageId: 0 }), MessageRecallError);
});

test("新功能前后端与部署产物接线完整", () => {
	const dialog = read("frontend/src/components/chat/AddConversationDialog.vue");
	assert.match(dialog, /isAdmin/);
	assert.match(dialog, /api\.searchContacts/);
	assert.match(dialog, /v-if="isAdmin"/);
	assert.match(dialog, /step = 'username'/);

	const menu = read("frontend/src/components/chat/MessageContextMenu.vue");
	assert.match(menu, /canRecall/);
	assert.match(menu, /messages\.recall/);
	assert.match(menu, /messages\.deleteBidirectional/);

	const room = read("frontend/src/composables/useChatRoom.js");
	assert.match(room, /recall_message/);
	assert.match(room, /message_recalled/);
	assert.match(read("frontend/src/components/chat/MessageRow.vue"), /messages\.recalledPlaceholder/);
	assert.match(read("frontend/public/sw.js"), /addEventListener\('push'/);
	assert.match(read("frontend/src/composables/useMessageSound.js"), /createOscillator/);

	const chat = read("frontend/src/pages/ChatPage.vue");
	assert.doesNotMatch(chat, /github\.com\/aozorae\/Edgechat/);
	assert.doesNotMatch(chat, /header-action--github/);
	assert.match(chat, /isSiteAdmin/);
	assert.match(chat, /can-recall="isSiteAdmin"/);
	assert.doesNotMatch(
		read("frontend/src/components/chat/MobileNavigationDrawer.vue"),
		/github\.com\/aozorae\/Edgechat/,
	);

	const api = read("frontend/src/api.js");
	assert.match(api, /searchContacts\(/);
	assert.match(api, /setContactAlias\(/);
	assert.match(read("frontend/src/composables/useContacts.ts"), /alias\?: string/);

	assert.match(read("worker/src/api/contacts.ts"), /\/api\/contacts\/search/);
	assert.match(read("worker/src/api/contacts.ts"), /\/api\/contacts\/:id\/alias/);
	assert.match(read("worker/src/api/channels.js"), /只有管理员可以创建群聊/);
	assert.match(read("worker/src/do/ChannelRoom.js"), /recall_message/);
	assert.match(read(".github/scripts/d1-migration-manifest.mjs"), /2026-11-12-message-recall-and-contact-aliases/);
	assert.match(read("worker/schema.sql"), /contact_aliases/);
	assert.match(read("worker/schema.sql"), /recalled_at TEXT/);
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		assert.match(read(`frontend/src/locales/${locale}.js`), /conversation\.addByUsername/);
		assert.match(read(`frontend/src/locales/${locale}.js`), /messages\.recalledPlaceholder/);
	}
});

test("消息提示音默认开启、可关闭且连发限流", () => {
	const store = new Map();
	const storage = {
		getItem: (key) => store.get(key) ?? null,
		setItem: (key, value) => store.set(key, value),
	};
	let started = 0;
	class FakeAudioContext {
		constructor() {
			this.state = "running";
			this.currentTime = 0;
			this.destination = {};
		}
		createOscillator() {
			return {
				type: "",
				frequency: { value: 0 },
				connect() {},
				start() { started += 1; },
				stop() {},
			};
		}
		createGain() {
			return {
				gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
				connect() {},
			};
		}
		resume() {}
	}
	const sound = useMessageSound({ storage, audioContextFactory: () => FakeAudioContext });
	assert.equal(sound.soundEnabled.value, true);
	assert.equal(sound.playMessageSound(), true);
	assert.ok(started >= 2, "双音提示");
	assert.equal(sound.playMessageSound(), false, "700ms 内连发被限流");
	assert.equal(sound.toggleSound(), false);
	assert.equal(store.get(MESSAGE_SOUND_STORAGE_KEY), "off");
	assert.equal(sound.playMessageSound(), false, "关闭后不再播放");
});
