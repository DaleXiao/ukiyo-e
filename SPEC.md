# SPEC: ukiyo-e wallpaper forge

**Status**: shipped 2026-04-23 (retroactive spec — see issue for流程违规记录)
**Owner**: Cindy → Rei (维护)
**Type**: web app (Cloudflare Pages + Worker + Durable Object)

## 一句话

用户输入场景描述（任意语言）→ qwen3.6-max-preview 自动选 2 个不同浮世绘大师风格 → wan2.7-image-pro 出 720×1560 竖版手机壁纸 → 在线 gallery + 下载。

## 4 master 风格（核心 IP）

| Master | 中文 | 适用场景 | 视觉特征 |
|---|---|---|---|
| Yoshitoshi (`yoshitoshi`) | 月冈芳年 | 武者/超自然/心理张力/惊悚 | 戏剧、强烈、有时血腥(Muzan-e) |
| Utamaro (`utamaro`) | 喜多川歌麿 | 单人优雅人物/Bijin-ga | 感性、精致、亲密肖像 |
| Hokusai (`hokusai`) | 葛饰北斋 | 山水/自然/天气/壮丽 | 几何、Aizuri 蓝、宏大 |
| Kuniyoshi (`kuniyoshi`) | 歌川国芳 | 武者/动作/神话/英雄 | 动感、Musha-e、夸张姿态 |

完整 prompt template 参考 `worker/src/index.ts` `STYLE_MAP`。

## 架构（继承自 icon-forge）

```
Browser → CF Pages (React/Vite) → CF Worker (api-ukiyo) → Durable Object Queue
                                       ↓
                          Kimi-compatible API (qwen3.6-max-preview)
                                       ↓
                          Dashscope (wan2.7-image-pro 720×1560)
                                       ↓
                          SSE stream back to client
```

## 关键差异 vs icon-forge

| 维度 | icon-forge | ukiyo-e |
|---|---|---|
| 输出尺寸 | 1024×1024 (icon) | 720×1560 (9:19.5 wallpaper) |
| 每日额度 | 3 | 5 |
| Prompt 模型 | kimi-k2.5 | qwen3.6-max-preview |
| 风格选择 | 5 styleWord 自由组合 | 4 master 必须选 2 不同 |
| 输出 fields | subject/visualDetails/contrastColors/moodWord/styleWord | master/centralFocus/environment/colorMaterial/atmosphere/moodWord |
| 文件命名 | icon-forge-{n}.png | ukiyo-e-{n}.png |
| 域名 | icon.weweekly.online / api-icon | ukiyo.weweekly.online / api-ukiyo |
| KV namespace | 3a4327db... | 1f3380fd6d70... |

## API contract（无变更，与 icon-forge 一致）

- `GET  /api/quota[?test]` → `{remaining, total}`
- `POST /api/generate[?test]` body `{description}` → `{taskId, position}` (202) or `{error, message}` (4xx/5xx)
- `GET  /api/generate/stream?taskId=X[&test]` → SSE: `generating` / `icon_ready` / `complete` / `error`

`?test` 跳 rate limit + 返回 99/99 quota。

## 部署

| 资源 | ID / 地址 |
|---|---|
| GitHub | `DaleXiao/ukiyo-e` |
| Cloudflare Worker | `ukiyo-e-worker` v51595ea6 |
| Durable Object | `GenerationQueue` (singleton) |
| KV namespace | `1f3380fd6d704fe5a12e73e37d159c4a` |
| Pages project | `ukiyo-e` |
| Web domain | https://ukiyo.weweekly.online |
| API domain | https://api-ukiyo.weweekly.online |
| Secret | `DASHSCOPE_API_KEY` (worker secret) |

## 已知非目标 (out of scope v1)

- ❌ 用户账号 / 历史 gallery（rate limit 仅按 IP）
- ❌ 一键设壁纸（Web 不支持，仅提供下载）
- ❌ 收藏 / 分享 link
- ❌ Batch 4 master 同时出
- ❌ 其他风格扩展（Sharaku、Hiroshige 等）

## Acceptance criteria

- [x] 4 master prompt template 完整、与提供的原始模板语义一致
- [x] qwen3.6-max-preview 输出合法 JSON、两个 variant 必为不同 master
- [x] wan2.7 720×1560 竖版正确出图
- [x] `?test` bypass 工作
- [x] 5 次/日 rate limit 工作
- [x] 端到端线上验证通过（"雨夜独行的狐姬" 出 2 张）
- [x] 自定义域名 SSL provisioned

APPROVED 2026-04-23 by Dale (verbal "可以" + retroactive A 方案确认).
