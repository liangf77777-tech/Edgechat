import { publicFileUrl } from "../utils.js";
import { activeUserSql, projectUserBan } from "../user-status.js";
import { AUTHORIZATION_COLUMNS, AUTHORIZATION_JOIN, authorizationFromRow } from '../rbac/authorization.ts';

function mapUserSummary(row) {
	return {
		id: Number(row.id),
		username: row.username,
		displayName: row.display_name,
		avatarUrl: row.avatar_key ? publicFileUrl(row.avatar_key) : "",
		...(row.alias !== undefined ? { alias: String(row.alias || "") } : {}),
	};
}

export async function getUserProfile(db, userId) {
	const { results } = await db.prepare(
		`SELECT id, username, display_name, avatar_key, bio
		 FROM users WHERE id = ? AND deleted_at IS NULL AND ${activeUserSql()} LIMIT 1`,
	).bind(userId).all();
	const row = results[0];
	return row ? { ...mapUserSummary(row), bio: row.bio } : null;
}

function mapAdminUser(row, includePermissions) {
	const { permissions, ...identity } = authorizationFromRow(row);
	return {
		...mapUserSummary(row),
		...projectUserBan(row),
		createdAt: row.created_at,
		...identity,
		...(includePermissions ? { permissions } : {}),
	};
}

export async function getUserByUsername(db, username) {
	const { results } = await db
		.prepare(
				`SELECT u.*, ${AUTHORIZATION_COLUMNS}
				 FROM users u ${AUTHORIZATION_JOIN}
				 WHERE u.username = ?
				   AND u.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(username)
		.all();
	return results[0] || null;
}

export async function isUserActiveById(db, userId) {
	const { results } = await db
		.prepare(
			`SELECT id
			 FROM users
			 WHERE id = ?
			   AND deleted_at IS NULL
				   AND ${activeUserSql()}
			 LIMIT 1`,
		)
		.bind(Number(userId))
		.all();
	return Boolean(results[0]);
}

export async function listActiveUsers(db, excludeUserId) {
	const { results } = await db
		.prepare(
			`SELECT id, username, display_name, avatar_key
			 FROM users
			 WHERE deleted_at IS NULL
				   AND ${activeUserSql()}
			   AND id != ?
			 ORDER BY display_name ASC`,
		)
		.bind(Number(excludeUserId))
		.all();
	return results.map(mapUserSummary);
}

export async function listContacts(db, ownerId = null) {
	// 传入 ownerId 时一并投影「我对该联系人的备注」，不传时保持原有行为。
	const includeAliases = Number.isFinite(Number(ownerId)) && Number(ownerId) > 0;
	const aliasColumn = includeAliases ? ", COALESCE(ca.alias, '') AS alias" : "";
	const aliasJoin = includeAliases
		? " LEFT JOIN contact_aliases ca ON ca.owner_id = ? AND ca.contact_id = users.id"
		: "";
	const statement = db.prepare(
		`SELECT users.id, users.username, users.display_name, users.avatar_key${aliasColumn}
		 FROM users${aliasJoin}
		 WHERE users.deleted_at IS NULL
		   AND ${activeUserSql("users")}
		 ORDER BY users.display_name ASC, users.username ASC, users.id ASC`,
	);
	const { results } = await (includeAliases ? statement.bind(Number(ownerId)) : statement).all();
	return results.map(mapUserSummary);
}

// 按用户名查找可添加的好友：优先精确匹配，无结果时再做前缀匹配。
// 只返回活跃、未删除、非本人的用户，避免把全站用户名枚举出去。
export async function searchContactsByUsername(db, { query, excludeUserId, limit = 8 }) {
	const q = String(query || "").trim();
	if (!q) {
		return [];
	}
	const ownerId = Number(excludeUserId);
	const shared = `SELECT users.id, users.username, users.display_name, users.avatar_key,
	       COALESCE(ca.alias, '') AS alias
	 FROM users
	 LEFT JOIN contact_aliases ca ON ca.owner_id = ? AND ca.contact_id = users.id
	 WHERE users.deleted_at IS NULL
	   AND ${activeUserSql("users")}
	   AND users.id != ?`;

	const exact = await db
		.prepare(`${shared} AND LOWER(users.username) = LOWER(?) LIMIT 1`)
		.bind(ownerId, ownerId, q)
		.all();
	if (exact.results.length) {
		return exact.results.map(mapUserSummary);
	}

	const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
	const cap = Math.max(1, Math.min(Number(limit) || 8, 20));
	const prefix = await db
		.prepare(
			`${shared} AND LOWER(users.username) LIKE LOWER(?) ESCAPE '\\'
			 ORDER BY users.username ASC LIMIT ?`,
		)
		.bind(ownerId, ownerId, `${escaped}%`, cap)
		.all();
	return prefix.results.map(mapUserSummary);
}

// 备注按「我的视角」存储：只影响自己对对方的显示名，对方不可见。
export async function setContactAlias(db, ownerId, contactId, alias) {
	const value = String(alias ?? "").trim().slice(0, 32);
	await db
		.prepare(
			`INSERT INTO contact_aliases (owner_id, contact_id, alias, updated_at)
			 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(owner_id, contact_id) DO UPDATE SET
			   alias = excluded.alias, updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(Number(ownerId), Number(contactId), value)
		.run();
	return value;
}

export async function getContactAlias(db, ownerId, contactId) {
	const { results } = await db
		.prepare(
			`SELECT alias FROM contact_aliases
			 WHERE owner_id = ? AND contact_id = ? LIMIT 1`,
		)
		.bind(Number(ownerId), Number(contactId))
		.all();
	return results[0] ? String(results[0].alias || "") : "";
}

export async function listAdminUsers(db, offset = 0, actor = null) {
	const { results } = await db
		.prepare(
				`SELECT u.id, u.username, u.display_name, u.avatar_key, u.is_disabled, u.disabled_until, u.created_at,
           ${AUTHORIZATION_COLUMNS}
				 FROM users u ${AUTHORIZATION_JOIN}
				 WHERE u.deleted_at IS NULL
				 ORDER BY u.created_at DESC, u.id DESC LIMIT 100 OFFSET ?`,
		)
			.bind(offset)
		.all();
	return results.map((row) => mapAdminUser(row, actor?.isSuperAdmin));
}

export async function listStorageOwners(db) {
	const { results } = await db
		.prepare(
			`SELECT id, username, display_name, deleted_at
			 FROM users
			 ORDER BY id ASC`,
		)
		.all();
	return results.map((row) => ({
		id: Number(row.id),
		username: row.username,
		displayName: row.display_name,
		isDeleted: Boolean(row.deleted_at),
	}));
}
