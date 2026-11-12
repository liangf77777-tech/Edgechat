import api from "../api.js";
import { createRealtimeSession } from "../realtime-session.js";
import { connectInboxSocket } from "../ws.js";

export function useUnreadInbox({
	activeRoom,
	applyConversationActivity,
	markConversationRead,
	roomApi = api,
	openInboxConnection = connectInboxSocket,
	notifyInApp = () => {},
	notifySystem = () => {},
	// 停留在当前会话时的普通新消息：只给声音提示，不弹应用内卡片。
	notifyActiveRoom = () => {},
		onCallEvent = () => {},
	isPageActive = () =>
		globalThis.document?.visibilityState === "visible" &&
		globalThis.document.hasFocus(),
}) {
	function isActiveRoom(room) {
		return (
			activeRoom.value &&
			activeRoom.value.kind === room.kind &&
			Number(activeRoom.value.id) === Number(room.id)
		);
	}

	const inboxSession = createRealtimeSession({
		openConnection(_params, handlers) {
			return openInboxConnection(handlers);
		},
		onMessage(payload) {
          if (payload.type === 'authorization_changed') {
            globalThis.window?.dispatchEvent(new Event('authorization-changed'));
            return;
          }
				if (payload.type?.startsWith('call_')) {
					onCallEvent(payload);
					return;
				}
			if (payload.type !== "room_message" || !payload.room) {
				return;
			}

			const pageActive = isPageActive();
			const needsAttention = Boolean(payload.mentionsMe || payload.replyToMe);
			if (isActiveRoom(payload.room) && pageActive) {
				markConversationRead(payload.room.kind, payload.room.id);
				void roomApi
					.markRoomRead(payload.room.kind, payload.room.id, payload.messageId)
					.catch(() => {});
				if (needsAttention) notifyInApp(payload);
				else notifyActiveRoom(payload);
				return;
			}

			applyConversationActivity({
				kind: payload.room.kind,
				roomId: payload.room.id,
				lastMessageAt: payload.createdAt,
				unreadCount: payload.unreadCount,
				mentionUnreadCount: payload.mentionUnreadCount,
			});
			if (pageActive) {
				notifyInApp(payload);
			} else {
				notifySystem(payload);
			}
		},
	});

	function connectUnreadInbox() {
		inboxSession.connect("inbox");
	}

	return {
		connectUnreadInbox,
		disconnectUnreadInbox: inboxSession.disconnect,
	};
}
