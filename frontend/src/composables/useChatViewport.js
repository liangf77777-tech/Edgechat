import { ref } from "vue";

// 用 CSS 媒体查询判断，保证 JS 的 class 与 @media (max-width: 960px) 永远一致。
// 过去首帧固定为 false，手机上会出现「侧栏 + 聊天区各占 100% 宽」而只看到半屏。
function detectMobileViewport() {
	if (typeof window === "undefined") return false;
	try {
		if (typeof window.matchMedia === "function") {
			return window.matchMedia("(max-width: 960px)").matches;
		}
	} catch (error) {
		// 老内核无法解析 media query 时退回宽度判断。
	}
	return (window.innerWidth || document.documentElement.clientWidth || 0) <= 960;
}

export function useChatViewport({ activeRoom }) {
	const isMobileViewport = ref(detectMobileViewport());
	const mobileView = ref(isMobileViewport.value && !activeRoom.value ? "list" : "chat");
	let viewportInitialized = false;

	function syncViewportState() {
		const nextIsMobile = detectMobileViewport();
		if (viewportInitialized && nextIsMobile === isMobileViewport.value) {
			return;
		}

		viewportInitialized = true;
		isMobileViewport.value = nextIsMobile;
		mobileView.value = nextIsMobile && !activeRoom.value ? "list" : "chat";
	}

	function syncViewportHeight() {
		const visualViewport = window.visualViewport;
		const viewportHeight =
			(visualViewport && visualViewport.height) ||
			window.innerHeight ||
			document.documentElement.clientHeight ||
			0;
		// 部分移动浏览器会在键盘弹出时平移视觉视口，只同步高度会让输入栏停在旧位置。
		document.documentElement.style.setProperty(
			"--chat-viewport-height",
			`${Math.round(viewportHeight)}px`,
		);
		document.documentElement.style.setProperty(
			"--chat-viewport-offset-top",
			`${Math.round((visualViewport && visualViewport.offsetTop) || 0)}px`,
		);
	}

	function startViewportSync() {
		syncViewportState();
		syncViewportHeight();
		window.addEventListener("resize", syncViewportState);
		window.addEventListener("resize", syncViewportHeight);
		window.addEventListener("orientationchange", syncViewportHeight);
		window.addEventListener("pageshow", syncViewportHeight);
		const visualViewport = window.visualViewport;
		if (visualViewport && typeof visualViewport.addEventListener === "function") {
			visualViewport.addEventListener("resize", syncViewportHeight);
			visualViewport.addEventListener("scroll", syncViewportHeight);
		}
	}

	function stopViewportSync() {
		window.removeEventListener("resize", syncViewportState);
		window.removeEventListener("resize", syncViewportHeight);
		window.removeEventListener("orientationchange", syncViewportHeight);
		window.removeEventListener("pageshow", syncViewportHeight);
		const visualViewport = window.visualViewport;
		if (visualViewport && typeof visualViewport.removeEventListener === "function") {
			visualViewport.removeEventListener("resize", syncViewportHeight);
			visualViewport.removeEventListener("scroll", syncViewportHeight);
		}
		document.documentElement.style.removeProperty("--chat-viewport-height");
		document.documentElement.style.removeProperty("--chat-viewport-offset-top");
	}

	function openConversationView() {
		if (isMobileViewport.value) {
			mobileView.value = "chat";
		}
	}

	function returnToConversationList() {
		if (isMobileViewport.value) {
			mobileView.value = "list";
		}
	}

	return {
		isMobileViewport,
		mobileView,
		startViewportSync,
		stopViewportSync,
		openConversationView,
		returnToConversationList,
	};
}
