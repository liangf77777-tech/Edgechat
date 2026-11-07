# EdgeChat 本 Fork 部署档案

本文件记录 `liangf77777-tech/Edgechat` 这套自有部署的实际情况，供日后维护、排障与重新部署时对照。上游通用文档见 https://echat.azora.top/ 。

## 站点与账号

| 项目 | 值 |
| --- | --- |
| 线上地址 | https://x.0123.you （登录页 `/login`，站点名 Chat X） |
| Cloudflare Account ID | `6cfe9499f05a42be825cca4d7c9131db` |
| Zone | `0123.you`（`b3b6645415befd809aa7e5860d4c9898`） |
| Worker / Service | `cfchat` |
| 默认分支 | `master` |
| 部署入口 | Actions → `00 Deploy Worker` |

## 资源清单（2026-11-07 核对）

| 资源 | 名称 | 状态 |
| --- | --- | --- |
| Workers | `cfchat` | 正常，`fetch` + `scheduled`，`has_assets` / `has_modules` |
| Static Assets | `ASSETS` | 正常，`run_worker_first = true`，SPA fallback |
| D1 | `cfchat-db` | 正常，schema 已建（35 张表，migration tag `v5`） |
| KV | `cfchat-sessions` | 正常，绑定 `SESSIONS` |
| R2 | `cfchat-files` | **待激活**：账户需补账单/卡片信息后才能启用；当前 Worker 无 `FILES` 绑定，附件与头像不可用 |
| Durable Objects | ChannelRoom / Scheduler / UserInbox / InstanceBridge / VoiceCall / TelegramNotifications | 6 个均已创建并绑定 |
| Cron Triggers | `*/15 * * * *` | 正常，UTC 19:00 轮次执行每日 GC |
| Worker Secrets | `EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID`、`EDGECHAT_ENCRYPTION_KEY_1`、`EDGECHAT_TURN_KEY_ID`、`EDGECHAT_TURN_API_TOKEN` | 前两项首次部署自动生成；后两项由 `00 Deploy Worker` 从 GitHub Secrets 注入 |
| 自定义域 | `x.0123.you` → `cfchat` / production | enabled，DNS 由平台自动写入 `AAAA 100::` |

## GitHub 侧配置

Repository Secrets（8 项）：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`EDGECHAT_ADMIN_USERNAME`、`EDGECHAT_ADMIN_PASSWORD`、`EDGECHAT_ADMIN_DISPLAY_NAME`、`EDGECHAT_TURN_KEY_ID`、`EDGECHAT_TURN_API_TOKEN`、`EDGECHAT_SYNC_TOKEN`。Repository Variable：`MESSAGE_RETENTION_DAYS = 30`。

工作流：`.github/workflows/` 下 `deploy-worker.yml`（显示名 `00 Deploy Worker`）、`deploy-demo.yml`、`sync-upstream.yml`、`android-ci.yml`、`capacitor-android-ci.yml`、`android-release.yml`、`post-deploy-check.yml`。

`wrangler.example.toml` 是唯一的部署模板，CI 会复制成 `wrangler.ci.toml` 并注入 D1 / KV / R2 的真实 ID；仓库中**不需要**也不应提交 `wrangler.toml`。

## 已知差距与处理

1. **R2 待激活**：Dashboard → R2 →「将 R2 订阅添加到我的帐户」会进入账单/卡片页面，账户当前无付款档案，CI 无法代填。文字聊天不受影响，但附件、头像、站点图标与语音消息上传不可用。填完卡片点击「激活 R2」后重跑 `00 Deploy Worker`，CI 会自动创建 `cfchat-files` 并注入 `FILES` 绑定。
2. **Repository Variables**：已显式设置 `MESSAGE_RETENTION_DAYS = 30`（普通 Variable，不是 Secret）。
3. **自动更新 PAT**：已创建仅授权本 fork 的 fine-grained PAT（Contents / Workflows 读写，仓库 `Edgechat`），写入 `EDGECHAT_SYNC_TOKEN`；`Sync Upstream` 现在可同步 `.github/workflows/` 变更。
4. **SITE_ORIGINS**：当前为空。若后续更换自定义域或需要清理历史站点图标引用，在 `wrangler.example.toml` 的 `[vars]` 中填入 `https://x.0123.you` 等完整 origin（逗号分隔、不带路径）。

## 重新部署与自检

- 手动部署：Actions → `00 Deploy Worker` → Run workflow，保持 `apply_encryption_keyring` 与 `rotate_encryption_key` 不勾选。
- 推送 `worker/`、`frontend/`、`shared/`、`test/`、`.github/scripts/`、`package.json`、`biome.json`、`wrangler.example.toml` 的变更会自动触发部署；仅改文档时手动运行即可。
- 部署完成后 `post-deploy-check.yml` 会自动探测 `https://x.0123.you/login`，连续 5 次不可达则让该次检查失败。
- 登录后台后可在「安装与维护」运行自检；用量查看见 https://echat.azora.top/guide/optimization.html 。

## 检查依据

对照官方文档「Cloudflare 资源与用量」「GitHub Actions 自动部署」「创建 Cloudflare API 令牌」「快速开始」「站点配置」「自动更新」「隐身模式」「项目结构」逐项核验。

## 2026-11-07 增量改动

- **general 全员群组隐藏**：会话列表与公共群组列表默认不再显示系统群。前端开关为 `frontend/src/channel-visibility.js` 的 `HIDE_GENERAL_CHANNEL`；后端 `GET /api/channels` 由 Worker 变量 `SHOW_GENERAL_CHANNEL=true` 恢复显示。系统群数据、成员关系、改名/删除保护与系统公告逻辑均未改动，相关测试已同步更新。
- **语音消息**：`frontend/src/components/chat/VoiceMessage.vue` 区分「浏览器拦截自动播放」（保留播放器与重试按钮）和「音源确实不可用」（降级为下载链接）；切换附件重置播放状态，媒体元素补 `playsinline`。
- **语音通话**：`frontend/src/calls/client.ts` 把远端音频元素隐藏挂载到文档并在连接关闭时移除，规避移动端「已接通但听不到声音」。
- **TURN 配置**：Cloudflare 已创建 TURN Key `edgechat-voice`，其 `uid` / `secret` 分别写入 GitHub Secrets `EDGECHAT_TURN_KEY_ID` / `EDGECHAT_TURN_API_TOKEN`；`deploy-worker.yml` 在部署后用 `wrangler secret put` 注入 Worker，私聊语音通话的自动 TURN 回退与强制中继模式随之可用。
- **验证**：本地 `npm run build:frontend` 通过；`npm test` 654/654 通过。
