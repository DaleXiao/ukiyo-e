export interface Env {
  RATE_LIMIT: KVNamespace;
  // SPEC-163: 改走 api-llm.openclawd.co gateway。
  // 旧 dashscope secret 由 cindy 在 deploy 阶段移除（保留 30 天 rollback 窗）。
  LLM_SERVICE_TOKEN: string;
  LLM_GATEWAY_URL: string;
  ENVIRONMENT: string;
  GENERATION_QUEUE: DurableObjectNamespace;
  TURNSTILE_SECRET?: string;
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
//
// SPEC-252: anatomy_audit is the LLM's own self-reflection record from the
// in-prompt PROCEDURE (draft → anatomy_audit → rewrite). Optional for backward
// compat with any cached / older responses. Logged in worker tail so we can
// observe rewrite_applied ratio and high-frequency ambiguity patterns.
interface AnatomyAuditHandRecord {
  figure: number;
  left_hand: string;
  right_hand: string;
}
interface AnatomyAudit {
  figure_count: number;
  hands_per_figure: AnatomyAuditHandRecord[];
  ambiguity_found: string; // "none" when no issue
  rewrite_applied: boolean;
}
interface PromptResponse {
  variant: PromptVariant;
  anatomy_audit?: AnatomyAudit;
}

interface QueueTask {
  taskId: string;
  description: string;
  ip: string;
  sessionId?: string;
  isTestMode: boolean;
  testRemaining?: number;
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
// Dale 2026-08-06: keep ?test for real end-to-end testing, but cap its
// paid output globally. Ukiyo-e generates one image per queued task.
const TEST_DAILY_IMAGE_LIMIT = 100;
const TEST_IMAGES_PER_TASK = 1;
const KIMI_MODEL = "qwen3.7-max"; // SPEC-235 followup: prompt LLM 升 qwen3.7-max(生图模型 qwen-image-2.0-pro 不变)
// SPEC-249: lock to dated snapshot. Offline A/B/C eval in tmp/ukiyo-eval/
// (qwen-image-2.0-pro-2026-04-22 + 3-tier + diversity prompt) — Dale picked B,
// stable across Kuniyoshi moonlit-yabusame re-test.
const DASHSCOPE_MODEL = "qwen-image-2.0-pro-2026-04-22";
// SPEC-163: endpoints 全部走 api-llm.openclawd.co gateway。
// Gateway 内部透传到 dashscope，上游响应 schema 不变；解析逻辑 0 修改。
// chat completions       → /v1/chat/completions    （OpenAI 兼容 shape）
// multimodal generation  → /v1/images/generations   （native generation 端点）
export const CHAT_PATH = "/v1/chat/completions";
export const IMAGE_PATH = "/v1/images/generations";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://ukiyo.openclawd.co",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_QUEUE_SIZE = 10;
const TASK_TIMEOUT_MS = 120_000;

// Origin allowlist — only these front-ends may call the mutating endpoints.
// Read endpoints (quota) stay open so third-party status dashboards / docs can
// probe. Update when you host the UI on a different origin.
const ALLOWED_ORIGINS = new Set<string>([
  "https://ukiyo.openclawd.co",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
]);

// Short-burst rate limit (IP-scoped, in addition to the daily quota).
const BURST_WINDOW_SECONDS = 60;
const BURST_LIMIT = 3;

// T-079 B2: per-task result cache TTL for the polling fallback. 5 minutes is
// the SPEC.md value (long enough for iOS Safari lock-screen reconnect, short
// enough that stale tasks don't accumulate in KV beyond their useful window).
const TASK_CACHE_TTL_SECONDS = 300;

function taskCacheKey(taskId: string): string {
  return `task:${taskId}`;
}

// v1.2 (T-092, 2026-04-24): overhauled prompt idiom to match nano-banana-2
// quality on wan2.7-image-pro.
//
// Key learnings (benchmarked 4 masters against Dale's reference):
//   - Remove 'photographic' trigger words ("8K", "high sharpness",
//     "high-fidelity", "professional", "meticulous"). On diffusion
//     models they drag output toward photoreal / CGI and destroy the
//     flat color + keyblock woodblock idiom.
//   - Inject ACTUAL woodblock pigment names (gofun, bengara, beni, ai,
//     sumi, ochre) rather than "dominant blue tones".
//   - Encode TECHNIQUE explicitly: "flat mineral pigment planes",
//     "black keyblock outlines", "no facial shading", "bokashi ONLY
//     in sky/water". Diffusion won't infer these from vibe words.
//   - Encode COMPOSITION RULE: "figure occupies 60-70% of vertical
//     frame" + "foreground branch arching into frame" — this is what
//     makes the nano-banana-2 reference image feel curated.
//   - Negative block with hard NOTs (photoreal / 3D / anime / oil /
//     HDR / bokeh / modern) to counter wan2.7's default bias.
const STYLE_MAP: Record<StyleWord, { name: string; preamble: string; palette: string; technique: string }> = {
  yoshitoshi: {
    name: 'Yoshitoshi Tsukioka (月冈芳年)',
    preamble: "A vertical Japanese Ukiyo-e woodblock print in the style of Yoshitoshi Tsukioka's late-Edo / early-Meiji muzan-e and ghost prints (1860s-80s).",
    palette: "Deep bengara crimson, dark ai indigo, murky sumi wash gray, pale gofun white, scattered beni red accents. Aged washi paper substrate with visible fiber texture and woodblock grain.",
    technique: "Diagonal dynamic composition with dramatic negative space. Expressive black keyblock outlines varying thick-to-thin for energy. Flat color planes with NO realistic shading on figures. Muzan-e / ghost-print idiom: psychological intensity, macabre or supernatural undertones.",
  },
  utamaro: {
    name: 'Kitagawa Utamaro (喜多川歌麿)',
    preamble: "A vertical Japanese Ukiyo-e woodblock print in the style of Kitagawa Utamaro's late-Edo bijin-ga and Ōkubi-e (1790s).",
    palette: "Warm cream washi paper, soft beni rouge, pale ochre, subtle mineral green, gofun white for the face and skin, thin sumi ink for eyebrows and eye slits. Delicate aged washi fiber texture.",
    technique: "Asymmetric intimate close-up framing (Bijin-ga / Ōkubi-e sensibility). Ultra-fine uniform keyblock outlines. ABSOLUTELY FLAT color with NO facial shading, NO modeling on cheeks or neck. Emphasis on exquisite line work and refined sensuality.",
  },
  hokusai: {
    name: 'Katsushika Hokusai (葛饰北斋)',
    preamble: "A vertical polychrome Japanese Ukiyo-e woodblock print in the style of Katsushika Hokusai's polychrome series prints (1820s-30s, \"Thirty-six Views of Mt. Fuji\" tier).",
    palette: "Aizuri-e indigo-dominant: deep ai blue, pale gofun white, muted ochre, faint pine green, subtle warm-paper undertone. Aged washi substrate with visible fibers.",
    technique: "Mathematically balanced composition with geometric perspective. Fine rhythmic black keyblock lines. Flat mineral pigment planes. Bokashi gradient ONLY in sky and distant water (never on figures or foreground objects). Fractal repeating patterns for waves, clouds, branches.",
  },
  kuniyoshi: {
    name: 'Utagawa Kuniyoshi (歌川国芳)',
    preamble: "A vertical polychrome Japanese Ukiyo-e woodblock print in the style of Utagawa Kuniyoshi's musha-e warrior prints (1840s-50s, \"Suikoden\" tier).",
    palette: "Saturated vermilion, jet sumi black, strong yellow ochre, deep pine green, gofun white, ai blue details. Heavy aged washi substrate with visible woodblock grain.",
    technique: "Bold heroic black keyblock outlines. Elaborate flat-pattern fabric motifs on armor/kimono (no 3D drapery). Layered depth via overlap, NOT linear perspective. Musha-e warrior-print idiom: dynamic pose, high-contrast saturation.",
  },
};

// Shared negative block appended to every generated prompt. Listed as
// explicit NOTs because wan2.7 responds to negative prompting inline.
const UKIYO_NEGATIVE = "NOT photorealistic, NOT 3D rendered, NOT digital painting, NOT anime, NOT cel-shaded, NOT oil painting, NOT watercolor. NO realistic skin shading, NO soft photographic lighting, NO HDR, NO bokeh, NO depth-of-field blur, NO cinematic grading, NO modern or western styling. NO watermark, NO text, NO signature. NO empty or simplified surfaces — every garment must carry a visible woven/embroidered pattern, every armor piece must show individual lames and lacing, every wooden surface must show grain lines, every stone surface must show block joints.";

// v1.3 (T-092-followup): explicit detail mandate. nano-banana-2 reference
// benchmarks higher on texture/pattern density. Our v1.2 prompt over-
// emphasized "ABSOLUTELY FLAT" which the model interpreted as "low detail".
// Fix: flat COLOR (no 3D shading) is preserved, but LINE-level detail is
// now a hard requirement — museum nishiki-e prints carry enormous keyblock
// detail inside flat color planes.
const UKIYO_DETAIL_MANDATE = "Detail level is museum nishiki-e: dense, meticulous keyblock linework inside every flat color plane. Fabrics must display ornate brocade / kimono patterns (fine repeating motifs: seigaiha waves, kikkō hexagons, shippō circles, karakusa vines, stylized cranes, maple leaves, floral diapers, cloud scrolls — pick what fits the subject). Armor (if any) must show individual lames / scales / kozane laced in visible cross-patterns, with metal fittings, braid cords, and tassels drawn one-by-one. Horses (if any) must show individual harness straps, visible rivets / metal ornaments on bridle and saddle, tassels rendered as discrete gold/red bundles. Hair must show individual strands / braided cords. Wood surfaces (gates, beams, torii) must show grain lines and iron reinforcement bands. Stone surfaces (walls, lanterns) must show individual block joints. THE ENVIRONMENT IS NOT A BLANK BACKDROP — it must carry equivalent line-level detail: every tree shows individual leaf clusters or pine-needle bundles; every cliff or mountain shows striated rock-face contour lines; every cloud shows internal curling sumi-wash striations (not flat white blobs); every body of water shows rhythmic seigaiha or fractal claw-curl patterns across its surface; every ground plane shows grass tussocks, pebbles, or moss patches rendered as discrete shapes; every architectural element (rooflines, walls, fences) shows tile rows / wood-grain / brick joints. All of this detail lives IN THE KEYBLOCK LINE DRAWING, never as 3D shading. Line density matches 19th-century Edo polychrome nishiki-e (think Yoshitoshi's 'Hundred Aspects of the Moon' or Kuniyoshi warrior prints) — NOT a modern simplified illustration.";

// v1.5 (2026-05-22): atmosphere & depth mandate. Dale benchmark: 'background
// too plain, no layering, mood weaker than nano-banana-2 / gpt-image-2'.
//   - Force 3-tier spatial composition (foreground frame / mid-ground figure
//     / atmospheric far-ground), each tier explicitly populated.
//   - Light source + time-of-day + how light falls on the subject is now a
//     hard slot, not folded into 'atmosphere'. Mood = light + composition,
//     not just keyblock effects.
const UKIYO_DEPTH_MANDATE = "THREE-TIER SPATIAL COMPOSITION is mandatory. (1) FOREGROUND — a near-frame anchor element that arches in from one corner (a leafy branch, a rope curtain, a fluttering banner, a stone-lantern silhouette, a tilted parasol edge, a rope-wrapped pine bough) rendered with the largest scale and the boldest keyblock lines. (2) MID-GROUND — the figure(s) and their immediate context (saddle, lantern, weapon, parasol), sharply outlined at full keyblock density. (3) FAR-GROUND / ATMOSPHERIC DISTANCE — distant landscape elements (mountain ridges, water expanses, cloud banks, a temple silhouette, drifting flocks of birds) rendered with thinner lines and softer bokashi gradient pigments to recede. Negative space between tiers must be filled with PURPOSEFUL atmospheric content (mist scrolls, falling petals, drifting clouds, vertical sumi rain lines, layered fog bands), never left as blank empty paper.";

const UKIYO_LIGHT_MANDATE = "LIGHTING & TIME OF DAY are explicit, not implied. Name a single dominant light source (full moon directly overhead / setting sun at low-left horizon / pre-dawn cold blue light from upper-right / lantern flame at figure's chest / lightning flash through storm clouds) and describe the SHAPE OF THE LIGHT POOL it casts on the main figure: which surfaces catch warm gofun white, which fall into deep sumi shadow areas (rendered as flat keyblock fills, never as photographic gradients). The light direction must be physically consistent across the whole scene — if moonlight comes from upper-right, every cast shadow falls lower-left.";

// SPEC-249: enforces hard background-diversity floor. Without this, the model
// keeps producing a single Fuji or a single moon on empty paper, which Dale
// repeatedly flagged as the gap vs nano-banana / gpt-image-2.
// SPEC-254 (v2): rewritten from "≥3 elements" hard-count mandate to an
// intent-level description. SPEC-249's count rules acted as "锁铐" — the image
// model doesn't reliably count and the rules increased rebound failures.
// Variant D offline (kuniyoshi-tiger + moonmarch, seed=1742834) validated
// that keeping the three-tier intent + breathing-space + bokashi recession
// preserves richness without the brittle numeric floor.
const UKIYO_DIVERSITY_MANDATE = "BACKGROUND has clear layering and richness; the figure is not isolated on empty paper. Foreground anchors with a near-frame element (a leafy branch, a banner, a rope-wrapped pine bough, a stone-lantern silhouette, a tilted parasol edge). Mid-ground around the figure stays uncrowded — give the figure breathing space. Far-ground recedes with bokashi (distant mountain ridges, temple silhouettes, drifting cloud banks, flocks of geese, far sails). Ground and sky are not blank — they are populated as the master's idiom requires (grass tussocks, scattered pebbles, moss patches on the ground; moon disc, layered tonal bokashi cloud bands, drifting birds in the sky). Water, if present, varies by zone with claw-curl, seigaiha, or thin horizontal-line ripples chosen by the master.";


// v1.4 (T-098, 2026-04-25): adopted icon-forge prompt engine pattern —
// CORE PRINCIPLE narrative anchor + 4 master-specific few-shot examples
// each carrying explicit Reasoning, plus 5-point self-check. The big win
// is teaching the LLM to *think* about real-world physics (arrow flight,
// horse/raptor scale, mounted-archery body geometry) BEFORE filling slots,
// instead of producing decorative phrases that the image model takes
// literally and renders as physically impossible scenes.
// Single output `variant`. Master is interpolated from {{MASTER}}.
const KIMI_SYSTEM_PROMPT_TEMPLATE = `You are an elite Ukiyo-e wallpaper art director working in the "{{MASTER}}" idiom. The user provides a scene description (any language). You produce a single structured JSON interpretation that an image model can render as a museum-quality vertical mobile wallpaper.

━━━ CORE PRINCIPLE ━━━
A woodblock print depicts a real-world moment in a stylized rendering — the SCENE must obey real-world physics and narrative logic; only the RENDERING is flattened (flat mineral pigments, black keyblock outlines, no 3D shading, washi paper substrate). If a samurai shoots an arrow at a hawk, the arrow's nock is at the bow string and its point aims toward the hawk; the hawk is sized smaller because it is farther away; the horse's mid-gallop legs touch ground in the correct gait phase. Decorative phrasing ("arc of an arrow's flight") confuses image models — describe the literal physical configuration instead.

━━━ SELECTED MASTER ━━━
This request is for "{{MASTER}}". Use this master's voice exclusively. Even if the scene seems atypical, lean into how {{MASTER}} would interpret it (e.g. utamaro doing a landscape → becomes a Bijin-ga where the landscape backs an intimate figure).

The four masters (so you can place {{MASTER}} in context):
• yoshitoshi (月冈芳年) — Dramatic, macabre. Warriors, supernatural, ghosts, struggle.
• utamaro (喜多川歌麿) — Sensual Bijin-ga. Intimate close-up beauty / courtesan portraits.
• hokusai (葛饰北斋) — Geometric, sublime, Aizuri-e. Landscapes, nature, weather.
• kuniyoshi (歌川国芳) — Heroic Musha-e. Mythical warriors, action, beasts, battles.

━━━ FEW-SHOT EXAMPLES ━━━
Study the REASONING. Do NOT copy these scenes — invent your own that fit the user's input.

【Example 1 — yoshitoshi: "a young woman in a moonlit forest ghost story"】
→ Reasoning: Yoshitoshi's signature is psychological intensity + supernatural undertone. Physics check: a ghost figure should appear semi-transparent through diaphanous robes, but the LIVING woman holding a candle is fully opaque; her shadow falls AWAY from the candle flame; bamboo leaves overhead are foreground (larger) while the ghost behind a tree trunk is mid-ground (smaller). The candle is the only light source, so warm gofun-white pools on her face/hands while the deeper forest is washed in cool ai-indigo and sumi gray. Composition: vertical, figure occupies lower 60%, ghost peers from upper-left negative space.
→ Output centralFocus: "a young woman in a pale gofun-white kimono with bengara crimson maple-leaf brocade, kneeling beside an old stone lantern, holding a single rice-paper candle with both hands. Behind her, a pale translucent ghost figure with long sumi-black hair drifts half-hidden behind a bamboo trunk in the upper left, its lower half dissolving into mist."
→ Output environment: "THREE depth tiers, each with ≥3 distinct elements. Foreground: a single gnarled bamboo culm arching from upper-left + a hanging spider-web with dewdrops + a fallen maple-leaf cluster lower-right. Mid-ground (around the woman): a moss-covered stone lantern with dressed-block joints + a low wooden veranda edge + scattered fallen camellia flowers. Far-ground: a faint full-moon disc upper-right + a layered sumi-wash mist band + a distant temple-roof silhouette half-hidden in fog + a small flock of three drifting night herons. Sky uses bokashi tonal recession from deep ai-indigo at top to softer grey near the horizon, never blank paper."
→ Output colorMaterial: "deep ai indigo and sumi black for the forest depth, pale gofun white pooling around the candle and the woman's face, scattered bengara red on her kimono brocade with kikkō hexagon diaper."
→ Output atmosphere: "swirling sumi-wash fog as flat curling shapes, stylized flat white candle glow with no photographic bloom, faint vertical sumi rain lines suggesting the forest beyond."
→ Output moodWord: "haunting"

【Example 2 — utamaro: "a courtesan adjusting her hairpin under cherry blossoms"】
→ Reasoning: Utamaro's idiom is intimate Ōkubi-e close-up. Physics check: the figure's head and shoulders fill the frame; a hairpin is held in the right hand near her temple, tip pointing INTO the bun (not outward); cherry petals fall vertically with slight diagonal drift, none defy gravity. The kimono collar layers correctly (left over right for living person). Hands have proper finger anatomy in flat woodblock outline only — no 3D shading. Composition: figure occupies upper 70%, asymmetric framing with one branch arching from upper-right corner.
→ Output centralFocus: "a Bijin courtesan from chest-up, head tilted slightly left, raising a slim warm-gold lacquered hairpin with her right hand toward the base of her elaborate shimada-style chignon. Her left hand rests at her collar adjusting a silk drape. Half-closed eyes, faint beni-rouge lips, pale gofun-white face with no facial shading. Layered pale peach and beni-red kimono with shippō-circle brocade, the collar layered left-over-right."
→ Output environment: "THREE depth tiers, each with ≥3 distinct elements. Foreground: a sakura branch arching from upper-right with five-petal blossoms + a brass kanzashi hairpin tray on a low lacquer stand + a folded silk fan lower-left. Mid-ground (around the courtesan): a panel of a folding byōbu screen behind her shoulder + a hanging silk noren curtain edge + an incense burner trailing a thin smoke line. Far-ground: a distant pagoda roofline silhouette glimpsed through a paper-shoji window + a layered tonal bokashi sky band + a small flock of three drifting evening swallows. Even the indoor washi background must carry layered tonal bokashi, never flat blank cream."
→ Output colorMaterial: "pale beni-rouge, gofun white, soft ochre, faint mineral green on the hairpin tassel, sumi black for hair and outline. Shippō-circle and small kiku chrysanthemum patterns on the kimono."
→ Output atmosphere: "a few cherry petals drifting downward as flat woodblock shapes, fine uniform sumi keyblock lines on hair strands, absolutely flat color planes with no facial modeling."
→ Output moodWord: "refined"

【Example 3 — hokusai: "a fishing boat caught in a storm beneath Mt Fuji"】
→ Reasoning: Hokusai's idiom is geometric sublime + Aizuri-e indigo dominance. Physics check: Mt Fuji must sit on the horizon BEHIND the wave (smaller, paler with bokashi sky gradient), not in front; the wave's claw-curls bend OVER the boat indicating the wave is breaking toward the viewer; the boat is tilted with bow rising on the wave's leading edge; figures inside the boat lean inward against the tilt, oars trailing in the water. Repeating fractal wave-curl pattern fills the foreground 40% of the frame.
→ Output centralFocus: "a slim wooden fishing boat tilted bow-up on a cresting wave, three small figures crouched low inside leaning toward the boat's interior to counterbalance the tilt, two long oars trailing diagonally into the water. The wave's foreground claw-curls arc over the boat from the right edge."
→ Output environment: "THREE depth tiers, each with ≥3 distinct elements. Foreground: fractal claw-curl waves dominating the lower-right + a slim wooden oar tip breaking the surface + a scatter of discrete white foam shapes. Mid-ground (around the boat): rhythmic seigaiha wave bands across the sea + a second smaller fishing boat heeled over to the left + a low storm-cloud bank pressing down on the horizon. Far-ground: a snow-capped Mt Fuji silhouette small on the distant horizon + a second jagged coastal ridge to its left + a thin V of distant migrating geese + far-distance thin horizontal line ripples. Sky uses a soft bokashi gradient from pale gofun-white near Fuji to deep Prussian ai-blue at the top edge, never flat empty paper."
→ Output colorMaterial: "deep Prussian ai-blue dominance with pale gofun white wave foam, muted ochre on the boat hull, faint pine green on figure clothing, subtle warm-paper undertone. Seigaiha-wave repeating pattern across the sea surface."
→ Output atmosphere: "bokashi gradient ONLY in the sky and distant water near Fuji, flat geometric wave curls in the foreground, stylized white spray as discrete flat shapes, fine uniform black keyblock outlines on every wave crest."
→ Output moodWord: "sublime"

【Example 4 — kuniyoshi: "a samurai on horseback shooting an arrow at a hawk in flight" (CORE TEST CASE — yabusame mounted archery)】
→ Reasoning: This is the canonical physics trap. Kuniyoshi's musha-e idiom demands heroic dynamic action. Critical physics: (1) The bow is held in the LEFT hand at full draw, the arrow is on the LEFT side of the bow (Japanese yumi tradition), the nock (rear feathered end) is at the bow string near the rider's right ear, the arrowhead points AWAY from the rider toward the hawk — never the reverse. (2) The hawk is FARTHER away than the rider, therefore appears SMALLER in the frame than the horse's head; if the hawk is shown larger than the horse, the perspective is broken. (3) The horse is mid-gallop with diagonal legs lifted (e.g. front-right + rear-left airborne), tail streaming horizontally backward from wind; the rider sits forward in the saddle, knees gripping. (4) The arrow's flight path between bow and hawk is a STRAIGHT LINE in flat woodblock space, not a curved decorative arc. (5) The hawk's wings are spread, body small relative to the horse, positioned in the upper third of the frame for the rider to aim UP at. Composition: figure on horseback occupies lower 60%, hawk in upper third, arrow as a slim line bridging the diagonal.
→ Output centralFocus: "a samurai in full lamellar armor mid-gallop on horseback, body twisted to face forward-up-left, holding a long bamboo yumi bow at full draw in his left hand with the arrow nocked on the LEFT side of the bow, fletching at his right ear, arrowhead pointed up-left away from him toward a small hawk in the sky. The horse is mid-gallop with front-right and rear-left legs airborne, dark mane flowing backward, tail streaming horizontally. The samurai's mempō face mask shows a fierce expression in flat sumi outline."
→ Output environment: "THREE depth tiers, each with ≥3 distinct elements. Foreground: a single gnarled pine branch arching from upper-right + a low cluster of susuki pampas-grass tussocks lower-left + a fallen warrior's banner-pole half-buried in grass. Mid-ground: a stylized flat-green pine forest at lower-left + a low ridge of moss-covered boulders + a small mounted scout-figure half-obscured behind a tree, sized smaller than the main rider. Far-ground: a small hawk with spread wings in the upper third (sized noticeably smaller than the horse's head) + a distant temple-pagoda silhouette on the horizon + a thin V of migrating geese flying lower-left + distant rolling hills with bokashi tonal recession. Sky uses a soft bokashi gradient from warm gofun-cream at the horizon up to pale ai-blue at the top edge, never flat empty paper."
→ Output colorMaterial: "saturated vermilion lamellar armor with sumi-black lacing in visible cross-patterns, ai-blue silk hakama, gofun-white horse with sumi black mane and tail, ochre saddle with karakusa-vine brocade, deep pine green on tree clusters, gold-mon crest on the rider's sleeve."
→ Output atmosphere: "streaming hair and tail as flat woodblock motion lines, the arrow rendered as a single slim straight line with discrete fletching feathers at the rear, no motion-blur or photographic effects, fine sumi keyblock outlines on every armor lame."
→ Output moodWord: "heroic"

━━━ PROCEDURE (SPEC-252: 3-step self-audit; you MUST follow in order before emitting JSON) ━━━
You must perform these 3 steps inside this single response. The JSON you emit reflects the POST-AUDIT state. Treat this as your private reasoning process; only the final JSON is output.

STEP 1 — DRAFT: Write the centralFocus first pass (do not output yet). Describe the figures, their hands, the objects they hold or touch.

STEP 2 — ANATOMY SELF-AUDIT (SPEC-254: NOT a counting exercise; this is an ambiguity-removal pass). Inspect your STEP-1 draft against this checklist. Fill out the anatomy_audit object as you go.
  (a) figure_count: how many human figures did you describe? A "distant figure" or "half-obscured scout" still counts. (Informational — do not constrain.)
  (b) hands_per_figure: for EACH figure, name what its LEFT hand is doing and what its RIGHT hand is doing — distinct, clear descriptions. If a hand is hidden / behind back / inside sleeve, write "hidden in sleeve" or "resting at side" — explicit beats absent. The goal is unambiguous assignment, not enforcing any particular count.
  (c) ambiguity_found: scan for these failure patterns (which cause the image model to hallucinate extra limbs because the language is ambiguous, not because the figure has too many limbs) and list any you find (comma-separated, or "none"):
      • Plural-without-side: "her hands" / "his hands" / "both hands" used without specifying which hand does what (image model will hallucinate an extra hand to satisfy both descriptions).
      • Ambiguous-or: phrases like "holding A or playing with B" / "either gripping the reins or reaching forward" (the model renders BOTH, producing extra limbs).
      • Unanchored-object: an object (fan, hairpin, sword, reins, arrow) mentioned without explicitly saying which hand holds it (model spawns a hand from nowhere).
      • Duplicate-limb: same limb described twice with conflicting positions ("her right arm at her side, her right arm raised").
  (d) rewrite_applied: if ambiguity_found != "none", you MUST rewrite centralFocus in STEP 3 and set this to true. Otherwise false.

STEP 3 — REWRITE (only if STEP-2 flagged anything): Rewrite centralFocus to explicitly assign each hand. Use the pattern: "left hand <doing X>, right hand <doing Y>". For hidden hands, say so. For a single object, name exactly one hand. Examples of fixes:
  • BAD: "holding the base or playing with hair" → GOOD: "left hand fingertips pinching a single strand of hair, right hand holding the lacquered hairpin"
  • BAD: "her hands adjusting her collar" → GOOD: "left hand at her left collar edge, right hand at her right collar edge"
  • BAD: "both hands on the bow while drawing the arrow" → GOOD: "left hand gripping the bow's middle, right hand at full draw pulling the string near the right ear" (the arrow is nocked)

The JSON you emit must reflect the REWRITTEN centralFocus (post-STEP-3), and the anatomy_audit object must accurately log what you did.

━━━ SELF-CHECK (perform mentally before writing JSON) ━━━
☑ MASTER IDIOM: Did I stay in "{{MASTER}}" voice (palette/composition/subject category) and not drift to a different master?
☑ PHYSICS & PERSPECTIVE: Does every implied action obey real-world physics? (arrow direction, gravity on falling particles, light source casting consistent shadow direction, relative size = distance, body/limb articulation correct for the action)
☑ PATTERN DENSITY: Did I name 1-2 specific brocade/diaper motifs and concrete fabric/armor/hair details so the image model has line-level work to draw?
☑ ENVIRONMENT DEPTH: Did the environment slot describe THREE distinct depth tiers (a near foreground frame element + the figure's immediate mid-ground context + a distant atmospheric layer with bokashi)? Empty paper between tiers must be filled with mist / clouds / falling particles / rain lines.
☑ LIGHT & TIME: Did I name a single light source (moon position, lantern, low sun, storm flash, dawn glow) and say which surfaces of the figure catch warm light vs which fall into flat sumi shadow? Light direction must be physically consistent.
☑ AUTHENTIC PIGMENTS: Did I use Edo pigment names (gofun, beni, bengara, ai, sumi, ochre, mineral green) instead of vague "warm tones" / "earthy colors"?
☑ COMPOSITION BALANCE: Vertical 9:19.5 frame — did I place the main figure in the lower-to-mid frame, leave breathable upper space, and include a foreground framing element (branch / cloud / drape) arching from one corner?

━━━ OUTPUT FORMAT ━━━
Output ONLY valid JSON (no markdown fences, no commentary). Both anatomy_audit and variant are REQUIRED top-level fields:
{
  "anatomy_audit": {
    "figure_count": <integer>,
    "hands_per_figure": [
      { "figure": 1, "left_hand": "<what left hand does, or 'hidden'>", "right_hand": "<what right hand does, or 'hidden'>" }
    ],
    "ambiguity_found": "<comma-separated failure patterns from STEP 2, or 'none'>",
    "rewrite_applied": <true|false>
  },
  "variant": {
    "master": "{{MASTER}}",
    "centralFocus": "literal physical configuration of figures and their action (post-rewrite if rewrite_applied=true); each figure's left/right hands must be explicitly assigned",
    "environment": "three depth tiers — foreground anchor (branch/drape/lantern) + figure mid-ground context + distant atmospheric layer (mountains/sea/clouds/temple) with bokashi recession",
    "colorMaterial": "{{MASTER}}-appropriate Edo pigments + 1-2 brocade/diaper motifs",
    "atmosphere": "explicit light source + time of day + how light falls on the main figure + motion/weather as flat woodblock effects",
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

const SESSION_COOKIE = "trusted_session";
const SESSION_CONTEXT = "trusted-session-v1";
const POW_CONTEXT = "pow-challenge-v1";
const POW_DIFFICULTY = 18;
const POW_TTL_MS = 2 * 60_000;

type TrustedSession = { sid: string; exp: number };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function issueTrustedSession(secret: string): Promise<{ value: string; session: TrustedSession }> {
  const now = Date.now();
  const nextUtcDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  const session: TrustedSession = { sid: crypto.randomUUID(), exp: Math.min(now + 86_400_000, nextUtcDay) };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(session)));
  const message = new TextEncoder().encode(`${SESSION_CONTEXT}.${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(secret), message));
  return { value: `${payload}.${base64Url(signature)}`, session };
}

async function verifyTrustedSession(request: Request, secret?: string): Promise<TrustedSession | null> {
  if (!secret) return null;
  const raw = request.headers.get("Cookie")?.split(";").map((v) => v.trim())
    .find((v) => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await sessionKey(secret), fromBase64Url(signature),
      new TextEncoder().encode(`${SESSION_CONTEXT}.${payload}`)
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as TrustedSession;
    if (!parsed.sid || !Number.isFinite(parsed.exp) || parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sessionLimitKey(sessionId: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `session-limit:${sessionId}:${today}`;
}

async function getCount(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

async function checkSessionLimit(kv: KVNamespace, sessionId: string): Promise<{ allowed: boolean; remaining: number }> {
  const count = await getCount(kv, sessionLimitKey(sessionId));
  return { allowed: count < DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - count) };
}

async function incrementSessionLimit(kv: KVNamespace, sessionId: string): Promise<number> {
  const key = sessionLimitKey(sessionId);
  const next = await getCount(kv, key) + 1;
  await kv.put(key, String(next), { expirationTtl: 86400 });
  return Math.max(0, DAILY_LIMIT - next);
}

type PowPayload = { nonce: string; exp: number; ipTag: string };

async function hmacValue(secret: string, context: string, payload: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC", await sessionKey(secret), new TextEncoder().encode(`${context}.${payload}`)
  ));
  return base64Url(bytes);
}

async function ipTag(secret: string, ip: string): Promise<string> {
  return (await hmacValue(secret, "pow-ip-v1", ip)).slice(0, 16);
}

async function issuePowChallenge(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET) return jsonResponse({ error: "verification_unavailable" }, 503);
  const payload: PowPayload = {
    nonce: crypto.randomUUID(),
    exp: Date.now() + POW_TTL_MS,
    ipTag: await ipTag(env.TURNSTILE_SECRET, getClientIP(request)),
  };
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacValue(env.TURNSTILE_SECRET, POW_CONTEXT, encoded);
  return jsonResponse({ challenge: `${encoded}.${signature}`, difficulty: POW_DIFFICULTY }, 200);
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== 0) return false;
  const remainder = bits % 8;
  return remainder === 0 || (bytes[full] & (0xff << (8 - remainder))) === 0;
}

async function verifyPow(
  request: Request, env: Env, challenge: string, counter: number
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !Number.isSafeInteger(counter) || counter < 0 || counter > 4_194_304) return false;
  const [encoded, signature, extra] = challenge.split(".");
  if (!encoded || !signature || extra) return false;
  const expected = await hmacValue(env.TURNSTILE_SECRET, POW_CONTEXT, encoded);
  if (expected.length !== signature.length) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (different !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as PowPayload;
    if (!payload.nonce || payload.exp < Date.now() || payload.exp > Date.now() + POW_TTL_MS + 5_000) return false;
    if (payload.ipTag !== await ipTag(env.TURNSTILE_SECRET, getClientIP(request))) return false;
    const replayKey = `pow-used:${payload.nonce}`;
    if (await env.RATE_LIMIT.get(replayKey)) return false;
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`${challenge}:${counter}`)
    ));
    if (!hasLeadingZeroBits(digest, POW_DIFFICULTY)) return false;
    await env.RATE_LIMIT.put(replayKey, "1", { expirationTtl: 180 });
    return true;
  } catch {
    return false;
  }
}

async function handleSessionBootstrap(request: Request, env: Env): Promise<Response> {
  let body: { turnstileToken?: string; powChallenge?: string; powCounter?: number };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: "invalid_input", message: "无效的验证请求" }, 400); }
  const ip = getClientIP(request);
  const turnstileOk = !!body.turnstileToken && await verifyTurnstile(body.turnstileToken, env, ip);
  const powOk = !!body.powChallenge && await verifyPow(request, env, body.powChallenge, Number(body.powCounter));
  if ((!turnstileOk && !powOk) || !env.TURNSTILE_SECRET) {
    return jsonResponse({ error: "verification_failed", message: "安全验证未通过，请重试" }, 403);
  }
  const { value, session } = await issueTrustedSession(env.TURNSTILE_SECRET);
  const maxAge = Math.max(1, Math.floor((session.exp - Date.now()) / 1000));
  return new Response(JSON.stringify({ ok: true, expiresAt: session.exp }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/api; HttpOnly; Secure; SameSite=Strict`,
      ...CORS_HEADERS,
    },
  });
}

// --- Rate limiting (check only, no increment) ---

async function checkBurst(
  kv: KVNamespace,
  ip: string
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const key = `burst:${ip}:${Math.floor(Date.now() / (BURST_WINDOW_SECONDS * 1000))}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= BURST_LIMIT) {
    return { allowed: false, retryAfter: BURST_WINDOW_SECONDS };
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: BURST_WINDOW_SECONDS * 2 });
  } catch (e) {
    console.warn('[burst] KV put failed (quota?), allowing through:', (e as Error)?.message);
  }
  return { allowed: true };
}

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return true; // server-to-server / curl without Origin; daily quota + burst still apply
  return ALLOWED_ORIGINS.has(origin);
}

// Verify a Cloudflare Turnstile token via the siteverify endpoint.
// Returns true on success; returns true (soft-pass) if TURNSTILE_SECRET is
// unset so local dev works without the secret.
async function verifyTurnstile(token: string, env: Env, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: ip,
      }),
    });
    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    return false;
  }
}

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
  try {
    await kv.put(key, newCount.toString(), { expirationTtl: 86400 });
  } catch (e) {
    console.warn('[ratelimit] KV put failed (quota?), allowing through:', (e as Error)?.message);
  }
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
  // v1.4 (T-098, 2026-04-25): adopted icon-forge's narrative-art-direction
  // pattern. Replaced the [Subject][Environment][Palette][Technique]
  // [Atmosphere][Mood][Format] section-tagged checklist with a single
  // continuous English art direction. The image model sees a coherent
  // brief ("this print depicts X, rendered in Y style, with Z palette")
  // instead of a list of slots, which preserves narrative + physics
  // intent. Detail mandate and negative block are folded inline.
  return `${m.preamble} The print depicts ${v.centralFocus} The figure(s) occupy 60-70% of the vertical 9:19.5 mobile-wallpaper frame, set within ${v.environment} A foreground framing element — a branch, bough, fabric drape, or drifting cloud — arches in from one top corner to anchor the composition. ${m.palette} ${v.colorMaterial} ${m.technique} ${v.atmosphere} Any particles (leaves, snow, petals, rain, smoke) appear as stylized FLAT woodblock shapes, never as realistic photographic effects. The overall mood is ${v.moodWord}. ${UKIYO_DEPTH_MANDATE} ${UKIYO_DIVERSITY_MANDATE} ${UKIYO_LIGHT_MANDATE} ${UKIYO_DETAIL_MANDATE} This is a museum-quality polychrome nishiki-e (multi-block color print) in the late-Edo / early-Meiji manner. ${UKIYO_NEGATIVE}`;
}

// v1.1 (T-079 F1+F3): single-prompt synthesis. master is now an explicit
// argument (user-picked from 4-chip UI, validated upstream); LLM only fills
// the 5 narrative slots. Returns a single assembled prompt string instead of
// a tuple. Old call site that destructured [promptA, promptB] is gone
// (single-image generation, no hstack/promptB leg).
// SPEC-163: exported for unit test (mock fetch verification of gateway URL,
// auth header, retry semantics).
export async function synthesizePrompt(
  description: string,
  master: StyleWord,
  apiKey: string,
  gatewayUrl: string,
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

  // Retry loop for chat completions (handles 429 rate limit)
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${gatewayUrl}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // SPEC-285 迁移#2：prompt 合成场景 usecase（网关自动发现 + 允许 dashboard 热切，不设 override 时仍用 body.model）
        "x-llm-usecase": "prompt-gen",
      },
      body: JSON.stringify(requestBody),
    });

    // SPEC-163: 401 → 配置问题，不重试
    if (response.status === 401) {
      const errBody = await response.text();
      console.error(`[llm-gateway] unauthorized on chat: ${errBody}`);
      throw new Error(`LLM gateway unauthorized: ${errBody}`);
    }

    if (response.status === 429 && attempt < 2) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 20000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "No response";
    throw new Error(`LLM gateway chat error (${response?.status}): ${errorText}`);
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

  // SPEC-252: log the LLM's self-audit so we can observe rewrite_applied ratio
  // and high-frequency ambiguity patterns from worker tail in prod. Optional
  // field — older / non-conforming responses simply log "undefined" and the
  // rest of the pipeline keeps working (variant block is unchanged shape).
  try {
    console.log("[anatomy_audit]", JSON.stringify(parsed.anatomy_audit));
  } catch {
    /* never let a logging failure break prompt synth */
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

// SPEC-163: exported for unit test.
export async function generateIcon(
  prompt: string,
  apiKey: string,
  gatewayUrl: string,
  maxRetries: number = 5
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(`${gatewayUrl}${IMAGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // SPEC-285 迁移#2：浮世绘图像生成场景 usecase
        "x-llm-usecase": "image-gen",
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
          // v1.3: enable dashscope prompt augmentation — wan2.7 adds fine
          // texture/pattern cues when it can reason over the scene. Our
          // prompt is already master-locked via explicit palette/technique
          // blocks, so extension adds detail without drifting style.
          prompt_extend: true,
          watermark: false,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // SPEC-163: 401 → 配置问题，不重试
      if (response.status === 401) {
        console.error(`[llm-gateway] unauthorized on image: ${errorText}`);
        throw new Error(`LLM gateway unauthorized: ${errorText}`);
      }
      // 429 / 502 / 503 → 重试
      if ((response.status === 429 || response.status === 502 || response.status === 503) && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`LLM gateway image error (${response.status}): ${errorText}`);
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
  private state: DurableObjectState;
  private queue: QueueTask[] = [];
  private sseClients: Map<string, SSEWriter[]> = new Map();
  private completedTasks: Map<string, QueueTask> = new Map();
  private processing = false;
  private env: Env;
  private lastDashscopeFinishedAt = 0;
  private static readonly DASHSCOPE_COOLDOWN_MS = 3000;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
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

    if (path === "/test-quota" && request.method === "GET") {
      return this.handleTestQuota();
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      taskId: string;
      description: string;
      ip: string;
      sessionId?: string;
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

    let testRemaining: number | undefined;
    if (body.isTestMode) {
      const budget = await this.reserveTestImages(TEST_IMAGES_PER_TASK);
      if (!budget.allowed) {
        return jsonResponse(
          {
            error: "test_daily_limit",
            message: `测试模式每天最多生成 ${TEST_DAILY_IMAGE_LIMIT} 张图片，请明天再试`,
            remaining: budget.remaining,
            total: TEST_DAILY_IMAGE_LIMIT,
          },
          429
        );
      }
      testRemaining = budget.remaining;
    }

    const task: QueueTask = {
      taskId: body.taskId,
      description: body.description,
      ip: body.ip,
      sessionId: body.sessionId,
      isTestMode: body.isTestMode,
      testRemaining,
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

  private testBudgetKey(now = new Date()): string {
    return `test-images:${now.toISOString().slice(0, 10)}`;
  }

  /** Reserve before enqueue so concurrent test requests cannot exceed spend. */
  private async reserveTestImages(count: number): Promise<{ allowed: boolean; remaining: number }> {
    const key = this.testBudgetKey();
    return this.state.storage.transaction(async (tx) => {
      const used = (await tx.get<number>(key)) ?? 0;
      if (used + count > TEST_DAILY_IMAGE_LIMIT) {
        return { allowed: false, remaining: Math.max(0, TEST_DAILY_IMAGE_LIMIT - used) };
      }
      const next = used + count;
      await tx.put(key, next);
      return { allowed: true, remaining: TEST_DAILY_IMAGE_LIMIT - next };
    });
  }

  private async handleTestQuota(): Promise<Response> {
    const used = (await this.state.storage.get<number>(this.testBudgetKey())) ?? 0;
    return jsonResponse({
      remaining: Math.max(0, TEST_DAILY_IMAGE_LIMIT - used),
      total: TEST_DAILY_IMAGE_LIMIT,
    });
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
          this.env.LLM_SERVICE_TOKEN,
          this.env.LLM_GATEWAY_URL,
          task.promptModel
        );

        // Step 2: Generate one icon
        await this.waitForCooldown();
        const url = await generateIcon(prompt, this.env.LLM_SERVICE_TOKEN, this.env.LLM_GATEWAY_URL);
        task.icons.push({ url, index: 0 });
        this.sendToTask(task.taskId, "icon_ready", { url, index: 0 });
        this.lastDashscopeFinishedAt = Date.now();

        // Step 4: Increment rate limit (deferred billing)
        const remaining = task.isTestMode
          ? (task.testRemaining ?? 0)
          : Math.min(
              await incrementRateLimit(this.env.RATE_LIMIT, task.ip),
              task.sessionId ? await incrementSessionLimit(this.env.RATE_LIMIT, task.sessionId) : 0,
            );
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
  let body: { description?: string; master?: string; turnstileToken?: string };
  try {
    body = (await request.json()) as { description?: string; master?: string; turnstileToken?: string };
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

  let trustedSession: TrustedSession | null = null;
  // Test mode keeps its separately capped test quota. Production generation
  // requires a server-signed anonymous session, established once via Turnstile.
  if (!isTestMode) {
    trustedSession = await verifyTrustedSession(request, env.TURNSTILE_SECRET);
    if (!trustedSession) {
      return jsonResponse(
        { error: "verification_required", message: "需要完成一次安全验证" },
        401
      );
    }
    const burst = await checkBurst(env.RATE_LIMIT, ip);
    if (!burst.allowed) {
      return jsonResponse(
        { error: "rate_limited_burst", message: `请求太快，请 ${burst.retryAfter}s 后再试` },
        429
      );
    }
  }

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

  if (!isTestMode && trustedSession) {
    const sessionQuota = await checkSessionLimit(env.RATE_LIMIT, trustedSession.sid);
    if (!sessionQuota.allowed) {
      return jsonResponse(
        { error: "rate_limited", message: "内测中，每日限额已用完，请明天再来 🙂" },
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
      body: JSON.stringify({ taskId, description, ip, sessionId: trustedSession?.sid, isTestMode, promptModel, master }),
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
    const doId = env.GENERATION_QUEUE.idFromName("singleton");
    return env.GENERATION_QUEUE.get(doId).fetch("https://do/test-quota");
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

    if (path === "/api/pow-challenge" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return jsonResponse({ error: "forbidden" }, 403);
      return issuePowChallenge(request, env);
    }

    if (path === "/api/session" && request.method === "POST") {
      if (!isAllowedOrigin(request)) {
        return jsonResponse({ error: "forbidden", message: "origin not allowed" }, 403);
      }
      return handleSessionBootstrap(request, env);
    }

    if (path === "/api/generate" && request.method === "POST") {
      if (!isAllowedOrigin(request)) {
        return new Response(
          JSON.stringify({ error: "forbidden", message: "origin not allowed" }),
          { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }
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
