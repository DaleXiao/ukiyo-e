# SPEC v1.1: ukiyo-e wallpaper forge

**Status**: in development (v1 已上线 retroactive, see T-078)
**Owner**: Cindy (协调) → Rei (实现)
**Type**: web app (Cloudflare Pages + Worker + Durable Object)

## Changelog

### v1.1 (2026-04-23 evening)

**Bug fix**:
- B1. quota 显示 "5/3" 应为 "5/5"：`/api/quota` total 字段从 hardcode `3` 改为 `DAILY_LIMIT=5`（worker side 已是 5，前端 fallback 也要改）
- B2. iOS 手机息屏 SSE 中断：保留 SSE 主路径，新增 `GET /api/task/:taskId` 轮询端点；前端监听 `visibilitychange`，可见态下 SSE 断开后切 5s 轮询，回前台 resume SSE。Worker 把任务结果写 KV TTL=5min 让轮询能拿到

**Feature**:
- F1. 单图生成（删 promptB / 删 hstack 拼图 leg），前端单卡片大尺寸（移动端宽度占满，桌面端 max-w-md ~ max-w-lg 居中）
- F2. 图片点击进全屏 lightbox（黑底，再点关闭）；右下悬浮下载按钮（简约 SVG 下箭头），删除独立"下载"按钮
- F3. Chip 改 4 master 风格选择（不再是示例 prompt）：
  - 月冈芳年 (yoshitoshi) / 喜多川歌麿 (utamaro) / 葛饰北斋 (hokusai) / 歌川国芳 (kuniyoshi)
  - 默认选中 hokusai
  - 用户选定后 POST `/api/generate` body 带 `master` 字段
  - Worker 收到 master 跳过"LLM 选 master"环节，仍调 qwen3.6-max-preview 填 centralFocus/environment/colorMaterial/atmosphere/moodWord
- F4. favicon + 网站页面图标换为 https://ph-files.imgix.net/8a91371d-15a0-4141-b4cb-f4bd69b0578a.png?auto=compress&codec=mozjpeg&cs=strip&auto=format&w=64&h=64&fit=crop&frame=1&dpr=2 → 下载到 `public/favicon.png` + 在 index.html 加 `<link rel="icon">` 引用
- F5. 生成尺寸升到 **iPhone 17 Pro Max 原生 1320×2868**（不降级）。Probe 已验证 wan2.7-image-pro 支持 `size="1320*2868"`
- F6. 进度百分比前的太阳旋转 emoji 替换为 unicode-animations `breathe` spinner：
  - 17 帧 100ms 间隔
  - 帧序列：`⠀ ⠂ ⠌ ⡑ ⢕ ⢝ ⣫ ⣟ ⣿ ⣟ ⣫ ⢝ ⢕ ⡑ ⠌ ⠂ ⠀`
  - 实现：前端直接 inline 帧数组（不引入 npm 包，避免 worker bundle 增大）

### v1.0 (2026-04-23 18:50, retroactive)

详见 git log + T-078。

## API contract

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/quota[?test] | - | `{remaining: int, total: 5}` |
| POST | /api/generate[?test] | `{description: string, master?: "yoshitoshi"\|"utamaro"\|"hokusai"\|"kuniyoshi"}` | `{taskId, position}` (202) / `{error,message}` (4xx/5xx) |
| GET | /api/generate/stream?taskId=X[&test] | - | SSE: `generating` / `icon_ready` (单条) / `complete` (含 1 张) / `error` |
| **GET (新)** | /api/task/:taskId[?test] | - | `{state: "queued"\|"generating"\|"complete"\|"error", icons?: [{url, index:0}], error?}` |

`master` 缺省 = `hokusai`。`?test` bypass quota + 返回 99/99。

## 4 master 中文映射 (前端 chip 显示)

| 中文 | 内部 id | 描述 (chip tooltip 可选) |
|---|---|---|
| 月冈芳年 | yoshitoshi | 戏剧/惊悚/超自然 |
| 喜多川歌麿 | utamaro | 优雅人物/Bijin-ga |
| 葛饰北斋 | hokusai | 山水/Aizuri 蓝（默认） |
| 歌川国芳 | kuniyoshi | 武者/动感/神话 |

## Out of scope (v1.1)

- 收藏 / 分享 link
- Service Worker / push notification (B2 用轮询 fallback 已够)
- 同时出 4 master 的 batch 模式
- 用户账号 / 历史 gallery

## Acceptance criteria

- [ ] B1: 首次访问 quota 显示 "5/5"，每次成功生成扣到 4/5、3/5
- [ ] B2: iOS Safari 锁屏 30s 后解锁，前端能继续看到结果（不报 connection lost）
- [ ] F1: 输入 prompt 出 1 张图，卡片宽度移动端 ~95vw 桌面端 ~480px
- [ ] F2: 点击图片进黑底全屏，右下角下载按钮可下载，再点关闭
- [ ] F3: 4 个 chip 显示中文 master 名，默认葛饰北斋高亮，切换正常
- [ ] F4: 浏览器 tab 显示新 favicon
- [ ] F5: 下载图片实测分辨率为 1320×2868
- [ ] F6: 生成中 spinner 是 breathe 帧序列动画，不是太阳 emoji
- [ ] 旧 `?test=` bypass 仍工作
- [ ] 5 次/日 rate limit 仍工作

## Rollback plan

`git revert HEAD~N main && wrangler deploy && wrangler pages deploy dist`. KV / DO 数据无破坏性变更（新增 task KV TTL 不影响旧 quota KV）。

APPROVED v1.1 by Dale 2026-04-23 21:22 (verbal "可以" + "继续啊。。。" 在 21:28).
