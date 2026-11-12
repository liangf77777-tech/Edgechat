import { recallMessage } from "./data/messages.js";
import { authorizeMessageRecall } from "./room-access.js";

export class MessageRecallError extends Error {
	constructor(message) {
		super(message);
		this.name = "MessageRecallError";
	}
}

// 撤回与删除的区别：撤回保留占位（所有成员看到「一条消息已被撤回」），
// 删除是双向移除（直接从所有人的时间线上消失）。两者都只允许站点管理员。
export function createMessageRecall({
	authorize = authorizeMessageRecall,
	persistRecall = recallMessage,
} = {}) {
	return async function recallRoomMessage(env, meta, payload) {
		const messageId = Number(payload.messageId);
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new MessageRecallError("消息不存在");
		}

		const access = await authorize(
			env.DB,
			meta.principal,
			meta.room.kind,
			meta.room.id,
		);
		if (!access.ok) {
			throw new MessageRecallError("只有管理员可以撤回消息");
		}

		const recalled = await persistRecall(env.DB, {
			channelId: meta.room.id,
			messageId,
			recalledBy: access.identity.userId,
		});
		if (!recalled) {
			throw new MessageRecallError("消息不存在、已被删除或已撤回");
		}

		return {
			messageId,
			packet: JSON.stringify({
				protocolVersion: 1,
				type: "message_recalled",
				messageId,
				recalledBy: access.identity.userId,
			}),
		};
	};
}

export const recallRoomMessage = createMessageRecall();
