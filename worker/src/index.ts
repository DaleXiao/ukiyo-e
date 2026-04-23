export interface Env {
  RATE_LIMIT: KVNamespace;
  DASHSCOPE_API_KEY: string;
  ENVIRONMENT: string;
  GENERATION_QUEUE: DurableObjectNamespace;
}

// --- Types ---

interface KimiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface KimiChatRequest {
  model: string;
  messages: KimiMessage[];
  response_format?: { type: string };
  temperature?: number;
  enable_thinking?: boolean;
  [key: string]: unknown;
}

interface KimiChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

type StyleWord = 'yoshitoshi' | 'utamaro' | 'hokusai' | 'kuniyoshi';

interface PromptVariant {
  master: StyleWord;
  centralFocus: string;        // 人物/动作
  environment: string;         // 环境
  colorMaterial: string;       // 色彩与材质
  atmosphere: string;          // 氛围动态
  moodWord: string;
}

// v1.0 returned variant_a + variant_b (two masters). v1.1 returns a single
// variant — the master is now picked by the user via 4-chip UI (F3), and
// hstack/promptB is gone (F1). Kept the wrapper interface so the
// prompt-extender LLM call can still keep its JSON schema explicit.
interface PromptResponse {
  variant: PromptVariant;
}

interface QueueTask {
  taskId: string;
  description: string;
  ip: string;
  isTestMode: boolean;
  promptModel: string;
  // v1.1 (T-079 F3): user-selected master from 4-chip UI. Always one of
  // the 4 valid StyleWords; defaults to 'hokusai' (Cindy spec). Worker
  // skips the LLM master-pick step and feeds this straight into the
  // detail-fill LLM call.
  master: StyleWord;
  status: "queued" | "generating" | "complete" | "error";
  // v1.1 (T-079 F1): single-image generation. icons[] retained as an
  // array of length 1 to preserve the SSE icon_ready event shape (so an
  // older mobile client mid-session doesn't crash on schema change), but
  // the queue/DO will only ever push exactly one entry with index:0.
  icons: Array<{ url: string; index: number }>;
  remaining?: number;
  errorMessage?: string;
  createdAt: number;
  currentIconIndex?: number;
}

interface SSEWriter {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  taskId: string;
}

// --- Constants ---

const DAILY_LIMIT = 5;
const KIMI_MODEL = "qwen3.6-max-preview";
const DASHSCOPE_MODEL = "wan2.7-image-pro";
const DASHSCOPE_SUBMIT_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const KIMI_API_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_QUEUE_SIZE = 10;
const TASK_TIMEOUT_MS = 120_000;

// T-079 B2: per-task result cache TTL for the polling fallback. 5 minutes is
// the SPEC.md value (long enough for iOS Safari lock-screen reconnect, short
// enough that stale tasks don't accumulate in KV beyond their useful window).
const TASK_CACHE_TTL_SECONDS = 300;

function taskCacheKey(taskId: string): string {
  return `task:${taskId}`;
}

const STYLE_MAP: Record<StyleWord, { name: string; preamble: string; styleNotes: string; outputQuality: string }> = {
  yoshitoshi: {
    name: 'Yoshitoshi Tsukioka (月冈芳年)',
    preamble: "A vertical Japanese Ukiyo-e woodblock print, rendered in the distinct, dynamic, intense, and often macabre style of the renowned master Yoshitoshi Tsukioka.",
    styleNotes: "Yoshitoshi Tsukioka's interpretation of the 'Ukiyo-e' tradition, particularly his focus on dynamic movement, psychological intensity, and sometimes 'Muzan-e' (cruel/bloody prints) or ghost/supernatural aesthetics. The composition is dynamic, often utilizing dramatic angles and diagonal compositions to enhance tension. High-fidelity, vintage Japanese Washi paper texture with visible woodblock grain pressure. Use expressive Sumi-ink lines that vary in thickness to define energy. Avoid static flatness; prioritize expressive line energy and dramatic contrasts. The visual language should feature intense drama, bizarre beauty, or historical gravity. Professional, meticulous, and artistic. The overall tone should be Dramatic and focused on 'Narrative' or 'Psychological' visual storytelling.",
    outputQuality: "Vertical (9:19.5 aspect ratio) optimized for mobile displays. 8K resolution, high sharpness, specific washi paper and woodblock texture, and no watermarks.",
  },
  utamaro: {
    name: 'Kitagawa Utamaro (喜多川歌麿)',
    preamble: "A vertical Japanese Ukiyo-e woodblock print, rendered in the distinct, sensual, and refined style of the renowned master Kitagawa Utamaro.",
    styleNotes: "Kitagawa Utamaro's interpretation of the 'Ukiyo-e' tradition, particularly his 'Bijin-ga' (beautiful person) aesthetics and 'Ōkubi-e' (close-up portrait) sensibility, even in wider shots. The composition is intimate, often asymmetrical, and focuses intensely on the figures' psychology. High-fidelity, vintage Japanese Washi paper texture with visible woodblock grain pressure. Use extremely fine, fluid Sumi-ink lines to define form. Avoid heavy shading or realistic depth; prioritize clean, flat color application and exquisite line work. The visual language should feature refined sensuality and delicate beauty. Professional, meticulous, and artistic. The overall tone should be Intimate and focused on 'Human' visual storytelling.",
    outputQuality: "Vertical (9:19.5 aspect ratio) optimized for mobile displays. 8K resolution, high sharpness, specific washi paper and woodblock texture, and no watermarks.",
  },
  hokusai: {
    name: 'Katsushika Hokusai (葛饰北斋)',
    preamble: "A vertical polychrome Japanese woodblock print (Ukiyo-e), rendered in the distinct, geometric, and sublime style of Katsushika Hokusai.",
    styleNotes: "the 'Ukiyo-e' art style, specifically focusing on 'Meisho-e' (famous places) aesthetics, paying homage to Katsushika Hokusai. The composition is elegant, mathematically balanced, and uses 'geometric' perspective. High-fidelity, vintage Woodblock Print texture on Washi paper. Use fine, rhythmic lines to define shapes. Avoid chaotic action; create depth through scale contrast and color gradients (Bokashi). The visual language should feature fractal patterns in nature and serene grandeur. Professional, meticulous, and artistic. The overall tone should be Sublime and focused on 'Poetic' visual storytelling.",
    outputQuality: "Vertical (9:19.5 aspect ratio) optimized for mobile displays. 8K resolution, high sharpness, specific wood grain texture, and no watermarks.",
  },
  kuniyoshi: {
    name: 'Utagawa Kuniyoshi (歌川国芳)',
    preamble: "A vertical polychrome Japanese woodblock print (Ukiyo-e), rendered in the distinct, dynamic, and mythical style of Utagawa Kuniyoshi.",
    styleNotes: "the 'Ukiyo-e' (floating world) art style, specifically 'Musha-e' (warrior prints), paying homage to Utagawa Kuniyoshi. The composition is bold, dynamic, and uses 'heroic' perspective. High-fidelity, vintage Woodblock Print texture on Washi paper. Use bold Sumi-ink outlines to define shapes. Avoid realistic 3D shading; create depth through layering and color gradients (Bokashi). The visual language should feature exaggerated poses and elaborate patterns. Professional, meticulous, and traditional. The overall tone should be Mythical and focused on 'Legendary' visual storytelling.",
    outputQuality: "Vertical (9:19.5 aspect ratio) optimized for mobile displays. 8K resolution, high sharpness, specific wood grain texture, and no watermarks.",
  },
};

// v1.1 (T-079 F3): user picks the master via 4-chip UI, so the LLM no longer
// chooses between masters — it just fills in the 5 narrative slots
// (centralFocus / environment / colorMaterial / atmosphere / moodWord) for the
// pre-selected master. Single output `variant`, not variant_a/variant_b.
// The CHOSEN_MASTER literal is interpolated into this template per-request so
// the LLM has explicit instructions about which master's idiom to honour
// (vs trying to be "master-aware" with conditional logic in one big prompt).
const KIMI_SYSTEM_PROMPT_TEMPLATE = `You are an elite Ukiyo-e wallpaper art director. Given a short scene description (any language) from a user, you produce a single visual interpretation as structured JSON, in the style of a SPECIFIC, PRE-SELECTED Ukiyo-e master.

━━━ SELECTED MASTER ━━━
This request is for: "{{MASTER}}"
You must use this master's voice exclusively. Do NOT pick a different master.

━━━ THE FOUR MASTERS (reference) ━━━
• "yoshitoshi" — 月冈芳年. Dramatic, intense, sometimes macabre. Best for: warriors, supernatural, psychological tension, struggle, ghosts.
• "utamaro" — 喜多川歌麿. Sensual, refined, intimate close-up portraiture (Bijin-ga). Best for: solo elegant figures, beauty, courtesans, intimate moments.
• "hokusai" — 葛饰北斋. Geometric, sublime, dominant Prussian Blue (Aizuri-e). Best for: landscapes, nature, weather, mountains, waves, serene grandeur.
• "kuniyoshi" — 歌川国芳. Dynamic, mythical, heroic warrior prints (Musha-e). Best for: legendary heroes, action, mythical beasts, epic battles.

━━━ CORE PRINCIPLE ━━━
The user provides a SCENE NAME (人物/地点/主题). Your job is to flesh out the missing visual details so the image model can render a museum-quality vertical mobile wallpaper IN THE "{{MASTER}}" IDIOM. Even if the scene seems atypical for this master, lean into how this master would interpret it (e.g. utamaro doing a landscape → it becomes a Bijin-ga where the landscape is a backdrop for an intimate figure).

━━━ OUTPUT FIELDS (ALL REQUIRED) ━━━
Fill these five narrative slots in vivid, specific English (the image model speaks English best):

• centralFocus — the precise figure(s)/action(s). Specific pose, gesture, expression. "a lone samurai mid-strike with sword raised, kimono billowing" not "a samurai".
• environment — the wider setting framing the figure. Specific architectural/natural elements that ground the scene.
• colorMaterial — dominant palette + textural hints, in {{MASTER}}-APPROPRIATE language. Examples: hokusai = "dominant Prussian Blue (Aizuri-e) tones mixed with pale yellows and vintage paper warmth"; yoshitoshi = "deep crimsons and dark indigoes against murky grays"; utamaro = "soft mineral pigments, ochre and rouge, on warm cream paper"; kuniyoshi = "saturated reds and bold blacks, dynamic high-contrast composition".
• atmosphere — dynamic/mood elements: line quality, motion, weather, particles, fabric flow.
• moodWord — single English mood word capturing the overall feeling.

━━━ SELF-CHECK BEFORE OUTPUT ━━━
☑ Did I keep master = "{{MASTER}}" (not pick a different one)?
☑ Is the colorMaterial idiomatic to {{MASTER}} specifically?
☑ Are centralFocus and environment specific enough that the image model has no ambiguity?

━━━ OUTPUT FORMAT ━━━
Output ONLY valid JSON (no markdown fences, no commentary):
{
  "variant": {
    "master": "{{MASTER}}",
    "centralFocus": "specific figure(s) + action + expression",
    "environment": "specific wider setting",
    "colorMaterial": "{{MASTER}}-appropriate palette + textural hints",
    "atmosphere": "motion, weather, line quality, fabric flow",
    "moodWord": "single english mood word"
  }
}`;

function buildKimiSystemPrompt(master: StyleWord): string {
  return KIMI_SYSTEM_PROMPT_TEMPLATE.replace(/\{\{MASTER\}\}/g, master);
}

// --- Helper functions ---

function jsonResponse(
  data: Record<string, unknown>,
  status: number = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function getTodayKey(ip: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `limit:${ip}:${today}`;
}

// --- Rate limiting (check only, no increment) ---

async function checkRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<{ allowed: boolean; remaining: number }> {
  const key = getTodayKey(ip);
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: DAILY_LIMIT - count };
}

async function incrementRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<number> {
  const key = getTodayKey(ip);
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  const newCount = count + 1;
  await kv.put(key, newCount.toString(), { expirationTtl: 86400 });
  return DAILY_LIMIT - newCount;
}

async function getRemainingQuota(
  kv: KVNamespace,
  ip: string
): Promise<number> {
  const key = getTodayKey(ip);
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  return Math.max(0, DAILY_LIMIT - count);
}

// --- Prompt synthesis ---

function assemblePrompt(v: PromptVariant): string {
  const m = STYLE_MAP[v.master] || STYLE_MAP.hokusai;
  return `${m.preamble}

**[The Scene]**
The visual content fills the frame. The central focus is on precisely and delicately figures depicting: ${v.centralFocus}.

The scene is set within a large, detailed environment representing ${v.environment}.

**[Details & Atmosphere]**
The scene specialize in ${m.styleNotes.replace(/^[a-zA-Z]/, c => c)} ${v.colorMaterial} emphasizes the figures. Atmospheric elements like ${v.atmosphere} are integrated throughout.

**[Output quality]**
${m.outputQuality}`;
}

// v1.1 (T-079 F1+F3): single-prompt synthesis. master is now an explicit
// argument (user-picked from 4-chip UI, validated upstream); LLM only fills
// the 5 narrative slots. Returns a single assembled prompt string instead of
// a tuple. Old call site that destructured [promptA, promptB] is gone
// (single-image generation, no hstack/promptB leg).
async function synthesizePrompt(
  description: string,
  master: StyleWord,
  apiKey: string,
  model: string = KIMI_MODEL
): Promise<string> {
  const requestBody: KimiChatRequest = {
    model,
    temperature: 0.8,
    enable_thinking: true,
    messages: [
      { role: "system", content: buildKimiSystemPrompt(master) },
      { role: "user", content: description },
    ],
  };

  // Retry loop for Kimi API (handles 429 rate limit)
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(KIMI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 429 && attempt < 2) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 20000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "No response";
    throw new Error(`Kimi API error (${response?.status}): ${errorText}`);
  }

  const data = (await response.json()) as KimiChatResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Kimi API returned empty content");
  }

  let parsed: PromptResponse;
  try {
    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
    }
    parsed = JSON.parse(cleaned) as PromptResponse;
  } catch {
    throw new Error(`Failed to parse Kimi response as JSON: ${content}`);
  }

  const v = parsed.variant;
  if (
    !v?.master ||
    !v?.centralFocus ||
    !v?.environment ||
    !v?.colorMaterial ||
    !v?.atmosphere ||
    !v?.moodWord
  ) {
    throw new Error(
      `Kimi response missing required fields in variant: ${JSON.stringify(v)}`
    );
  }
  // Force the user-selected master even if the LLM tried to drift. The chip
  // selection is the source of truth (T-079 F3 acceptance: "默认葛饰北斋高亮,
  // 切换正常"). Override is silent rather than throwing because the prompt
  // body LLM produced is still scene-relevant; only the master tag drifted.
  v.master = master;

  return assemblePrompt(v);
}

// --- Image generation ---

async function generateIcon(
  prompt: string,
  apiKey: string,
  maxRetries: number = 5
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(DASHSCOPE_SUBMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DASHSCOPE_MODEL,
        input: {
          messages: [
            {
              role: "user",
              content: [{ text: prompt }],
            },
          ],
        },
        parameters: {
          // T-079 F5: iPhone 17 Pro Max native resolution. Probe verified
          // wan2.7-image-pro accepts "1320*2868". Output PNG ~2.5MB; we don't
          // downscale on the worker side — spec acceptance is "下载图片实测分辨率
          // 为 1320×2868". The image bytes flow through dashscope's CDN URL
          // (worker only stores the URL), so the worker bandwidth cost is
          // unchanged regardless of pixel count.
          size: "1320*2868",
          n: 1,
          seed: Math.floor(Math.random() * 2147483647),
          prompt_extend: false,
          watermark: false,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429 && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`Dashscope error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      output?: {
        choices?: Array<{
          message?: {
            content?: Array<{ image?: string }>;
          };
        }>;
      };
      code?: string;
      message?: string;
    };

    if (data.code) {
      if (data.code === "Throttling.RateQuota" && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`Dashscope API error: ${data.code} - ${data.message}`);
    }

    const imageUrl = data.output?.choices?.[0]?.message?.content?.[0]?.image;
    if (!imageUrl) {
      throw new Error(`Dashscope returned no image: ${JSON.stringify(data)}`);
    }

    return imageUrl;
  }

  throw new Error("[throttled] Dashscope image generation failed after retries");
}

// --- Durable Object: GenerationQueue ---

export class GenerationQueue {
  // @ts-expect-error: kept for future state hydration
  private _state: DurableObjectState;
  private queue: QueueTask[] = [];
  private sseClients: Map<string, SSEWriter[]> = new Map();
  private completedTasks: Map<string, QueueTask> = new Map();
  private processing = false;
  private env: Env;
  private lastDashscopeFinishedAt = 0;
  private static readonly DASHSCOPE_COOLDOWN_MS = 3000;

  constructor(state: DurableObjectState, env: Env) {
    this._state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/enqueue" && request.method === "POST") {
      return this.handleEnqueue(request);
    }

    if (path === "/stream" && request.method === "GET") {
      return this.handleStream(request);
    }

    if (path === "/status" && request.method === "GET") {
      return this.handleStatus(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      taskId: string;
      description: string;
      ip: string;
      isTestMode: boolean;
      promptModel: string;
      master: StyleWord;  // T-079 F3: validated upstream in handleGenerate
    };

    // Clean up timed-out tasks
    this.cleanupTimedOut();

    // Check queue capacity
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return jsonResponse(
        {
          error: "queue_full",
          message: "当前使用人数较多，请 30 秒后再试",
          retryAfter: 30,
        },
        503
      );
    }

    const task: QueueTask = {
      taskId: body.taskId,
      description: body.description,
      ip: body.ip,
      isTestMode: body.isTestMode,
      promptModel: body.promptModel || KIMI_MODEL,
      master: body.master,
      status: "queued",
      icons: [],
      createdAt: Date.now(),
    };

    this.queue.push(task);
    const position = this.queue.length;

    // Start processing if not already
    if (!this.processing) {
      this.processQueue();
    }

    return jsonResponse({ taskId: task.taskId, position }, 202);
  }

  private handleStream(request: Request): Response {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");

    if (!taskId) {
      return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);
    }

    // Check if task exists in queue or completed holding area
    const task = this.queue.find((t) => t.taskId === taskId) || this.completedTasks.get(taskId) || null;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sseWriter: SSEWriter = { writer, taskId };

    // Register the SSE client
    if (!this.sseClients.has(taskId)) {
      this.sseClients.set(taskId, []);
    }
    this.sseClients.get(taskId)!.push(sseWriter);

    // Send current state immediately if task exists
    if (task) {
      const sendCurrentState = async () => {
        try {
          if (task.status === "queued") {
            const position = this.queue.findIndex((t) => t.taskId === taskId) + 1;
            await writer.write(
              encoder.encode(`event: queued\ndata: ${JSON.stringify({ position })}\n\n`)
            );
          } else if (task.status === "generating") {
            await writer.write(
              encoder.encode(
                `event: generating\ndata: ${JSON.stringify({ index: task.currentIconIndex ?? 0, total: 1 })}\n\n`
              )
            );
            // Send any already-completed icons
            for (const icon of task.icons) {
              await writer.write(
                encoder.encode(
                  `event: icon_ready\ndata: ${JSON.stringify({ url: icon.url, index: icon.index })}\n\n`
                )
              );
            }
          } else if (task.status === "complete") {
            // Send all icons and complete
            for (const icon of task.icons) {
              await writer.write(
                encoder.encode(
                  `event: icon_ready\ndata: ${JSON.stringify({ url: icon.url, index: icon.index })}\n\n`
                )
              );
            }
            await writer.write(
              encoder.encode(
                `event: complete\ndata: ${JSON.stringify({ icons: task.icons, remaining: task.remaining })}\n\n`
              )
            );
            await writer.close();
            this.removeSseClient(taskId, sseWriter);
          } else if (task.status === "error") {
            await writer.write(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ message: task.errorMessage })}\n\n`
              )
            );
            await writer.close();
            this.removeSseClient(taskId, sseWriter);
          }
        } catch {
          // Client disconnected
          this.removeSseClient(taskId, sseWriter);
        }
      };
      sendCurrentState();
    } else {
      // Task not found — might have already been cleaned up
      const sendNotFound = async () => {
        try {
          await writer.write(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: "任务不存在或已过期" })}\n\n`
            )
          );
          await writer.close();
        } catch {
          // ignore
        }
      };
      sendNotFound();
      this.removeSseClient(taskId, sseWriter);
    }

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      },
    });
  }

  private handleStatus(request: Request): Response {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");

    if (!taskId) {
      return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);
    }

    const task = this.queue.find((t) => t.taskId === taskId) || this.completedTasks.get(taskId) || null;
    if (!task) {
      return jsonResponse({ error: "not_found", message: "任务不存在或已过期" }, 404);
    }

    const position = this.queue.findIndex((t) => t.taskId === taskId) + 1;
    return jsonResponse({
      taskId: task.taskId,
      status: task.status,
      position,
      icons: task.icons,
      remaining: task.remaining,
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];

      // Skip if already completed/errored (shouldn't happen, but safety)
      if (task.status === "complete" || task.status === "error") {
        this.queue.shift();
        continue;
      }

      // Notify all queued tasks of their position
      this.broadcastQueuePositions();

      try {
        // Mark as generating
        task.status = "generating";
        task.currentIconIndex = 0;
        // T-079 F1: total=1 (single image). Old client may still expect
        // total=2 in payload but the SSE event shape is forward-compatible
        // (extra fields ignored).
        this.sendToTask(task.taskId, "generating", { index: 0, total: 1 });

        // Step 1: Synthesize a single prompt for the user-selected master
        // (T-079 F1+F3 — no more variant_a/variant_b LLM call, no master pick)
        const prompt = await synthesizePrompt(
          task.description,
          task.master,
          this.env.DASHSCOPE_API_KEY,
          task.promptModel
        );

        // Step 2: Generate one icon
        await this.waitForCooldown();
        const url = await generateIcon(prompt, this.env.DASHSCOPE_API_KEY);
        task.icons.push({ url, index: 0 });
        this.sendToTask(task.taskId, "icon_ready", { url, index: 0 });
        this.lastDashscopeFinishedAt = Date.now();

        // Step 4: Increment rate limit (deferred billing)
        const remaining = task.isTestMode
          ? 99
          : await incrementRateLimit(this.env.RATE_LIMIT, task.ip);
        task.remaining = remaining;

        // Complete
        task.status = "complete";
        this.sendToTask(task.taskId, "complete", {
          icons: task.icons,
          remaining,
        });

        // T-079 B2: persist final result to KV with TTL=5min so the polling
        // fallback (GET /api/task/:taskId) can pick up the result even after
        // mobile Safari kills the SSE connection on screen lock. The DO's
        // in-memory completedTasks map already serves the same role for
        // same-DO-instance reads, but Workers may spin up a fresh DO pod
        // for the polling request, so KV is the durable bridge.
        try {
          const cacheKey = taskCacheKey(task.taskId);
          await this.env.RATE_LIMIT.put(
            cacheKey,
            JSON.stringify({ state: "complete", icons: task.icons, remaining }),
            { expirationTtl: TASK_CACHE_TTL_SECONDS }
          );
        } catch (kvErr) {
          // Non-fatal: poll endpoint will return 404, frontend will keep SSE
          // reconnect path active. Don't block the user-visible 'complete'.
          console.error("task cache write failed (complete):", kvErr);
        }
      } catch (error) {
        console.error("Generation failed:", error);
        const errMsg = error instanceof Error ? error.message : String(error);
        const isThrottled =
          errMsg.includes("Throttling") ||
          errMsg.includes("429") ||
          errMsg.includes("[throttled]");

        task.status = "error";
        task.errorMessage = isThrottled
          ? "服务器繁忙，请等待 30 秒后重试"
          : "生成失败，请稍后重试";
        this.sendToTask(task.taskId, "error", { message: task.errorMessage });

        // T-079 B2: persist error state to KV too so polling fallback can
        // surface the failure even after SSE drop.
        try {
          const cacheKey = taskCacheKey(task.taskId);
          await this.env.RATE_LIMIT.put(
            cacheKey,
            JSON.stringify({ state: "error", error: task.errorMessage }),
            { expirationTtl: TASK_CACHE_TTL_SECONDS }
          );
        } catch (kvErr) {
          console.error("task cache write failed (error):", kvErr);
        }
      }

      // Keep completed/errored task in queue briefly for SSE reconnection
      // Move to a "done" holding area, clean up after 30s
      this.queue.shift();
      this.completedTasks.set(task.taskId, task);
      setTimeout(() => {
        this.completedTasks.delete(task.taskId);
        this.closeSseClients(task.taskId);
      }, 300000); // 5 minutes — allows mobile Safari to reconnect after lock screen
    }

    this.processing = false;
  }

  private async waitForCooldown(): Promise<void> {
    if (this.lastDashscopeFinishedAt === 0) return;
    const elapsed = Date.now() - this.lastDashscopeFinishedAt;
    const remaining = GenerationQueue.DASHSCOPE_COOLDOWN_MS - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private broadcastQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status === "queued") {
        this.sendToTask(task.taskId, "queued", { position: i + 1 });
      }
    }
  }

  private sendToTask(taskId: string, event: string, data: Record<string, unknown>): void {
    const clients = this.sseClients.get(taskId);
    if (!clients || clients.length === 0) return;

    const encoder = new TextEncoder();
    const message = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const toRemove: SSEWriter[] = [];
    for (const client of clients) {
      try {
        client.writer.write(message);
      } catch {
        toRemove.push(client);
      }
    }

    // Clean up disconnected clients
    for (const client of toRemove) {
      this.removeSseClient(taskId, client);
    }
  }

  private closeSseClients(taskId: string): void {
    const clients = this.sseClients.get(taskId);
    if (!clients) return;

    for (const client of clients) {
      try {
        client.writer.close();
      } catch {
        // already closed
      }
    }
    this.sseClients.delete(taskId);
  }

  private removeSseClient(taskId: string, client: SSEWriter): void {
    const clients = this.sseClients.get(taskId);
    if (!clients) return;

    const idx = clients.indexOf(client);
    if (idx !== -1) {
      clients.splice(idx, 1);
    }
    if (clients.length === 0) {
      this.sseClients.delete(taskId);
    }
  }

  private cleanupTimedOut(): void {
    const now = Date.now();
    this.queue = this.queue.filter((task) => {
      if (now - task.createdAt > TASK_TIMEOUT_MS) {
        this.sendToTask(task.taskId, "error", {
          message: "任务超时，请重新提交",
        });
        this.closeSseClients(task.taskId);
        return false;
      }
      return true;
    });
  }
}

// --- Request handlers ---

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function handleGenerate(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { description?: string; master?: string };
  try {
    body = (await request.json()) as { description?: string; master?: string };
  } catch {
    return jsonResponse(
      { error: "invalid_input", message: "请提供有效的 JSON 请求体" },
      400
    );
  }

  const description = body.description?.trim();
  if (!description || description.length < 2 || description.length > 200) {
    return jsonResponse(
      { error: "invalid_input", message: "请描述场景（2-200 字）" },
      400
    );
  }

  // T-079 F3: validate master against the 4-master allowlist; default to
  // hokusai per spec when missing/invalid (silently — no 400, the chip UI
  // is the source of truth and any drift is a frontend bug we can recover
  // from server-side without breaking the user's request).
  const validMasters: StyleWord[] = ["yoshitoshi", "utamaro", "hokusai", "kuniyoshi"];
  const master: StyleWord = validMasters.includes(body.master as StyleWord)
    ? (body.master as StyleWord)
    : "hokusai";

  const ip = getClientIP(request);
  const url = new URL(request.url);
  const isTestMode = url.searchParams.has("test");
  const promptModel = KIMI_MODEL;

  // Check rate limit before queuing
  if (!isTestMode) {
    const { allowed } = await checkRateLimit(env.RATE_LIMIT, ip);
    if (!allowed) {
      return jsonResponse(
        {
          error: "rate_limited",
          message: "内测中，每日限额已用完，请明天再来 🙂",
        },
        429
      );
    }
  }

  // Forward to Durable Object
  const taskId = generateTaskId();
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);

  const doResponse = await doStub.fetch(
    new Request("https://do/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, description, ip, isTestMode, promptModel, master }),
    })
  );

  // Forward the DO response (either 202 with taskId/position, or 503 queue_full)
  const responseBody = await doResponse.text();
  return new Response(responseBody, {
    status: doResponse.status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

async function handleStream(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");

  if (!taskId) {
    return jsonResponse(
      { error: "missing_taskId", message: "缺少 taskId 参数" },
      400
    );
  }

  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);

  const doResponse = await doStub.fetch(
    new Request(`https://do/stream?taskId=${encodeURIComponent(taskId)}`, {
      method: "GET",
    })
  );

  // Return SSE response with CORS headers
  return new Response(doResponse.body, {
    status: doResponse.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

async function handleQuota(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const isTestMode = url.searchParams.has("test");

  if (isTestMode) {
    return new Response(JSON.stringify({ remaining: 99, total: 99 }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const ip = getClientIP(request);
  const remaining = await getRemainingQuota(env.RATE_LIMIT, ip);
  return new Response(JSON.stringify({ remaining, total: DAILY_LIMIT }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

// T-079 B2: GET /api/task/:taskId polling fallback. iOS Safari kills SSE
// when the screen locks; the frontend (App.tsx) detects this via
// `visibilitychange` and switches to 5s polling against this endpoint until
// the page is visible again. The contract:
//
//   200 {state: "complete", icons: [{url, index:0}], remaining}
//   200 {state: "error", error: string}
//   200 {state: "queued"|"generating"} when DO has it but it's not done
//   404 {state: "unknown"} when neither DO nor KV cache has the task
//
// Reads are layered: DO first (covers in-flight tasks while still in queue
// or being generated), KV second (covers post-completion cleanup window).
// KV TTL=5min matches DO completedTasks holding window so the bridge is
// seamless even if a different DO pod handles the polling request.
async function handleTaskStatus(
  _request: Request,
  env: Env,
  taskId: string
): Promise<Response> {
  if (!taskId || !/^task_[a-z0-9_]+$/i.test(taskId)) {
    return jsonResponse(
      { error: "invalid_taskId", message: "任务 ID 格式不正确" },
      400
    );
  }

  // Step 1: ask the DO (in-memory queue + completed holding area).
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);
  type DOStatus = {
    taskId: string;
    status: "queued" | "generating" | "complete" | "error";
    position: number;
    icons: Array<{ url: string; index: number }>;
    remaining?: number;
    errorMessage?: string;
  };
  let doData: DOStatus | null = null;
  try {
    const doResponse = await doStub.fetch(
      new Request(`https://do/status?taskId=${encodeURIComponent(taskId)}`, { method: "GET" })
    );
    if (doResponse.ok) {
      doData = (await doResponse.json()) as DOStatus;
    }
  } catch (e) {
    // DO unreachable — fall through to KV. Don't fail the polling request,
    // it'll just feel slightly stale (KV is the durable bridge).
    console.error("DO status fetch failed:", e);
  }

  if (doData && doData.taskId) {
    if (doData.status === "complete") {
      return jsonResponse({
        state: "complete",
        icons: doData.icons,
        remaining: doData.remaining,
      });
    }
    if (doData.status === "error") {
      return jsonResponse({
        state: "error",
        error: doData.errorMessage || "生成失败，请重试",
      });
    }
    return jsonResponse({ state: doData.status });
  }

  // Step 2: KV fallback. The DO writes the final state under task:<id> on
  // complete or error; this is what survives DO eviction or pod migration.
  try {
    const cached = await env.RATE_LIMIT.get(taskCacheKey(taskId));
    if (cached) {
      const parsed = JSON.parse(cached) as {
        state: "complete" | "error";
        icons?: Array<{ url: string; index: number }>;
        remaining?: number;
        error?: string;
      };
      return jsonResponse(parsed);
    }
  } catch (e) {
    console.error("KV task cache read failed:", e);
  }

  return jsonResponse({ state: "unknown", error: "任务不存在或已过期" }, 404);
}

// --- Main Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }

    if (path === "/api/generate/stream" && request.method === "GET") {
      return handleStream(request, env);
    }

    if (path === "/api/quota" && request.method === "GET") {
      return handleQuota(request, env);
    }

    // T-079 B2: GET /api/task/:taskId polling fallback for iOS lock-screen.
    // Match path-param style; ?test bypass is honored via the same DO path
    // that handleStream already uses (no separate test branch needed since
    // ?test only affects rate-limit / quota mocking, not task lookup).
    {
      const m = path.match(/^\/api\/task\/([A-Za-z0-9_-]+)$/);
      if (m && request.method === "GET") {
        return handleTaskStatus(request, env, m[1]);
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: CORS_HEADERS,
    });
  },
};
