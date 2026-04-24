# Changelog

All notable changes to `ukiyo-e` are recorded here. Dates are GMT+8.

## v1.3 — 2026-04-24

- **Detail mandate** prompt block: requires dense keyblock linework (brocade patterns, kozane lame-lacing, harness rivets, wood grain, stone joints) inside flat color planes, to match late-Edo / early-Meiji museum nishiki-e density. Fixes the v1.2 "too simplified" look benchmarked against Gemini nano-banana-2.
- Kimi system prompt: `centralFocus` / `environment` / `colorMaterial` each now required to name specific fabric patterns (seigaiha / kikkō / shippō / karakusa / kiku) and materials.
- Negative block extended: "NO empty or simplified surfaces".
- Dashscope `prompt_extend`: false → true (style is already master-locked via preamble + palette + technique, extension only adds density without drift).
- Open-source release: MIT license, README, CHANGELOG. Removed `skills/` symlinks and workspace-local `SPEC.md` / `PRD.md` / `TASK.md` from git history.

## v1.2 — 2026-04-23 evening (T-086)

- Chip label switched from scene examples to master-artist names (月冈芳年 / 喜多川歌麿 / 葛饰北斋 / 歌川国芳).
- Progress spinner: rain-drop unicode animation replacing sun emoji.

## v1.1 — 2026-04-23 (T-079, 2 bugfix + 6 feature)

- B1 quota display "5/3" → "5/5".
- B2 iOS screen-lock SSE drop: add `GET /api/task/:id` polling fallback, frontend switches on `visibilitychange`. Worker writes result to KV with 5 min TTL.
- F1 single-image generation (removed A/B variant + hstack).
- F2 lightbox on click, floating download button.
- F3 4-master chip UI; user-selected master bypasses LLM master-pick step.
- F4 custom favicon.
- F5 iPhone 17 Pro Max native resolution 1320×2868.
- F6 breathe spinner (17-frame unicode animation, inline, no npm dep).

## v1.0 — 2026-04-23 18:50 (T-078, retroactive)

- Initial release forked from icon-forge architecture: Cloudflare Pages + Worker + Durable Object queue, Dashscope wan2.7-image-pro image generation, Kimi/Qwen prompt synthesis, 4 Edo-period masters, SSE streaming, KV rate limit.
