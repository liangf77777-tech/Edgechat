import assert from "node:assert/strict";
import test from "node:test";
import {
	HIDE_GENERAL_CHANNEL,
	isGeneralGroupChannel,
	isHiddenChannel,
	visibleChannels,
} from "../frontend/src/channel-visibility.js";

test("general 全员群组的各种数据形态都会被识别", () => {
	assert.equal(isGeneralGroupChannel({ name: "general", kind: "public" }), true);
	assert.equal(isGeneralGroupChannel({ name: "General", kind: "public", isGeneral: true }), true);
	assert.equal(isGeneralGroupChannel({ name: "general", kind: "private", isGeneral: false }), true);
	assert.equal(isGeneralGroupChannel({ name: "team", kind: "public" }), false);
	assert.equal(isGeneralGroupChannel({ name: "general", kind: "dm" }), false);
	assert.equal(isGeneralGroupChannel(null), false);
});

test("隐藏开关只过滤 general，不影响私聊与其它群组", () => {
	assert.equal(HIDE_GENERAL_CHANNEL, true);
	const channels = [
		{ id: 1, name: "general", kind: "public", isGeneral: true },
		{ id: 2, name: "General", kind: "public" },
		{ id: 3, name: "team", kind: "public" },
		{ id: 4, name: "design", kind: "private" },
	];
	assert.deepEqual(visibleChannels(channels).map((item) => item.id), [3, 4]);
	assert.equal(isHiddenChannel(channels[0]), true);
	assert.equal(isHiddenChannel(channels[2]), false);
	assert.deepEqual(visibleChannels(null), []);
});
