# ukiyo-e 浮世绘

AI Ukiyo-e wallpaper forge. Pick one of four Edo-period masters (Yoshitoshi / Utamaro / Hokusai / Kuniyoshi), type a scene, get a vertical 1320×2868 iPhone-ready wallpaper rendered in that master's idiom.

**Live**: [ukiyo.weweekly.online](https://ukiyo.weweekly.online)

## Architecture

```
Frontend (React + Vite + Tailwind)        → Cloudflare Pages
          │
          ▼
Worker (Cloudflare Workers + Durable Object)
          │   ├─ queue + rate limit (KV)
          │   ├─ prompt synthesis  → Kimi (moonshot) / Qwen3.6-max-preview
          │   └─ image generation  → Dashscope wan2.7-image-pro
          ▼
     Dashscope OSS → signed PNG URL → stream back via SSE
```

## Local Development

```bash
# Frontend
npm install
npm run dev                # vite on http://localhost:5173

# Worker
cd worker
npm install
npx wrangler dev           # http://localhost:8787
```

## Deploy

### Prerequisites
- Cloudflare account with Workers + Pages + one zone (edit `wrangler.toml` routes)
- A Dashscope (Alibaba Cloud Model Studio) API key with access to
  `wan2.7-image-pro` and at least one chat model (`kimi-k2-thinking` or
  `qwen3.6-max-preview`)

### Configure secrets (server-side, never committed)
```bash
cd worker
npx wrangler secret put DASHSCOPE_API_KEY
# paste your key when prompted
```

Optional (only needed if you use a Kimi/Moonshot key separate from your
Dashscope-compatible account; the default worker calls Kimi via the Dashscope
compatible-mode endpoint and reuses `DASHSCOPE_API_KEY`):
```bash
npx wrangler secret put KIMI_API_KEY
```

### Create the KV namespace
```bash
npx wrangler kv:namespace create RATE_LIMIT
# copy the id into wrangler.toml under [[kv_namespaces]]
```

### Deploy
```bash
# Worker
cd worker && npx wrangler deploy

# Frontend to Cloudflare Pages (from repo root)
npm run build
npx wrangler pages deploy dist --project-name ukiyo-e
```

## Prompt Engineering Notes

The worker builds its image prompt from a per-master preamble + palette +
technique block, plus LLM-filled narrative slots (`centralFocus` /
`environment` / `colorMaterial` / `atmosphere` / `moodWord`). See
`worker/src/index.ts` for the `STYLE_MAP`, `UKIYO_NEGATIVE`, and
`UKIYO_DETAIL_MANDATE` blocks — the "museum nishiki-e density" directive
is what pushes wan2.7 toward authentic 19th-century polychrome woodblock
output instead of a modern simplified illustration.

## License

MIT — see [LICENSE](LICENSE).
