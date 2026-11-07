// 站点级显示策略：把 general 全员群组从会话列表、公共群组列表里隐藏。
// 需要恢复显示时把 HIDE_GENERAL_CHANNEL 改为 false（后端对应 SHOW_GENERAL_CHANNEL=true）。
// 只影响展示层，不删除系统群、不改动成员关系、删除/改名保护与系统公告数据。
export const HIDE_GENERAL_CHANNEL = true;

const GENERAL_CHANNEL_NAME = "general";

export function isGeneralGroupChannel(channel) {
	if (!channel || channel.kind === "dm") return false;
	return (
		Boolean(channel.isGeneral) ||
		String(channel.name || "").trim().toLowerCase() === GENERAL_CHANNEL_NAME
	);
}

export function isHiddenChannel(channel) {
	return HIDE_GENERAL_CHANNEL && isGeneralGroupChannel(channel);
}

export function visibleChannels(channels) {
	return (channels || []).filter((channel) => !isHiddenChannel(channel));
}
