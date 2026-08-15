// SPEC-340 (T-630) follow-up: unit tests for the trusted anonymous session,
// session/IP quota, burst limit, and the Pow fallback introduced by PR #34/#35.
//
// The implementation shipped without automated coverage for these paths
// (flagged by Lynx in the SPEC-340 review); this file closes that gap.
// Acceptance coverage (spec §验收):
//   - cookie sign/verify/expiry/tamper
//   - bootstrap success/failure
//   - missing-session denial
//   - trusted generation reaching the queue
//   - IP + session quota (independent, per-spec item 5)
//   - burst limit
//   - PoW fallback failure paths + challenge issuance
//   - (frontend "retry once" lives in App.tsx, out of worker scope)

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DAILY_LIMIT,
  BURST_LIMIT,
  BURST_WINDOW_SECONDS,
  SESSION_COOKIE,
  SESSION_CONTEXT,
  POW_DIFFICULTY,
  base64Url,
  hmacValue,
  issueTrustedSession,
  verifyTrustedSession,
  sessionLimitKey,
  checkSessionLimit,
  incrementSessionLimit,
  getTodayKey,
  checkRateLimit,
  incrementRateLimit,
  getRemainingQuota,
  checkBurst,
  hasLeadingZeroBits,
  issuePowChallenge,
  verifyPow,
  handleSessionBootstrap,
  handleGenerate,
} from "../src/index";

const SECRET = "test-secret-123";

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- minimal KV / DurableObject stubs (not typechecked: test/ excluded from tsconfig) ---

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as any;
}

function makeDoQueue(onEnqueue: (body: any) => Response) {
  return {
    idFromName: () => ({ id: "singleton" }),
    get: () => ({
      fetch: async (req: Request) => onEnqueue(await req.json()),
    }),
  } as any;
}

function reqWithCookie(cookieValue: string | null): Request {
  const headers = new Headers();
  if (cookieValue != null) headers.set("Cookie", `${SESSION_COOKIE}=${cookieValue}`);
  return new Request("https://ukiyo.openclawd.co/api/generate", { headers });
}

// ---------------------------------------------------------------------------
// Cookie sign / verify / expiry / tamper
// ---------------------------------------------------------------------------

describe("trusted session cookie", () => {
  it("issues value of shape payload.signature and round-trips through verify", async () => {
    const { value, session } = await issueTrustedSession(SECRET);

    expect(value).toMatch(/^.+\..+$/);
    expect(session.sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const now = Date.now();
    expect(session.exp).toBeGreaterThan(now);
    // capped at 24h and at the next UTC day boundary
    expect(session.exp).toBeLessThanOrEqual(now + 86_400_000);

    const verified = await verifyTrustedSession(reqWithCookie(value), SECRET);
    expect(verified).not.toBeNull();
    expect(verified!.sid).toBe(session.sid);
    expect(verified!.exp).toBe(session.exp);
  });

  it("returns null when the Cookie header is missing", async () => {
    expect(await verifyTrustedSession(reqWithCookie(null), SECRET)).toBeNull();
  });

  it("returns null when no secret is configured", async () => {
    const { value } = await issueTrustedSession(SECRET);
    expect(await verifyTrustedSession(reqWithCookie(value), undefined)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", async () => {
    const { value } = await issueTrustedSession("secret-A");
    expect(await verifyTrustedSession(reqWithCookie(value), "secret-B")).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const { value } = await issueTrustedSession(SECRET);
    const [payload, sig] = value.split(".");
    const flipped = sig[0] === "A" ? "B" + sig.slice(1) : "A" + sig.slice(1);
    expect(flipped).not.toBe(sig);
    expect(await verifyTrustedSession(reqWithCookie(`${payload}.${flipped}`), SECRET)).toBeNull();
  });

  it("rejects a payload whose signature does not match", async () => {
    const { value } = await issueTrustedSession(SECRET);
    const [, sig] = value.split(".");
    const forged = base64Url(new TextEncoder().encode(JSON.stringify({ sid: "evil", exp: Date.now() + 1_000_000 })));
    expect(await verifyTrustedSession(reqWithCookie(`${forged}.${sig}`), SECRET)).toBeNull();
  });

  it("rejects an expired session (exp in the past)", async () => {
    const payload = base64Url(new TextEncoder().encode(JSON.stringify({ sid: "expired-sid", exp: Date.now() - 1_000 })));
    const sig = await hmacValue(SECRET, SESSION_CONTEXT, payload);
    expect(await verifyTrustedSession(reqWithCookie(`${payload}.${sig}`), SECRET)).toBeNull();
  });

  it("rejects a malformed value with extra segments", async () => {
    expect(await verifyTrustedSession(reqWithCookie("a.b.c"), SECRET)).toBeNull();
  });

  it("rejects a garbage payload that fails base64/JSON decoding", async () => {
    const sig = await hmacValue(SECRET, SESSION_CONTEXT, "!!!!");
    expect(await verifyTrustedSession(reqWithCookie(`!!!!.${sig}`), SECRET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PoW fallback helpers
// ---------------------------------------------------------------------------

describe("PoW fallback helpers", () => {
  it("hasLeadingZeroBits checks full bytes and remainder bits", () => {
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0x00]), 16)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x01, 0x00]), 16)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0x00]), 8)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x01]), 8)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0xff]), 0)).toBe(true); // 0 bits always true
    expect(hasLeadingZeroBits(new Uint8Array([0x0f]), 4)).toBe(true); // top 4 bits zero
    expect(hasLeadingZeroBits(new Uint8Array([0x10]), 4)).toBe(false);
  });

  it("issuePowChallenge returns a signed challenge with the configured difficulty", async () => {
    const env = { TURNSTILE_SECRET: SECRET } as any;
    const res = await issuePowChallenge(new Request("https://ukiyo.openclawd.co/api/pow-challenge", { method: "POST" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string; difficulty: number };
    expect(body.difficulty).toBe(POW_DIFFICULTY);
    expect(body.challenge).toMatch(/^.+\..+$/);
  });

  it("issuePowChallenge returns 503 when no turnstile secret is configured", async () => {
    const res = await issuePowChallenge(new Request("https://ukiyo.openclawd.co/api/pow-challenge", { method: "POST" }), {} as any);
    expect(res.status).toBe(503);
  });

  it("verifyPow fails closed without a secret", async () => {
    const req = new Request("https://x/", { method: "POST" });
    expect(await verifyPow(req, {} as any, "challenge.sig", 0)).toBe(false);
  });

  it("verifyPow rejects a malformed challenge", async () => {
    const env = { TURNSTILE_SECRET: SECRET, RATE_LIMIT: makeKv() } as any;
    const req = new Request("https://x/", { method: "POST" });
    expect(await verifyPow(req, env, "no-dot", 0)).toBe(false);
  });

  it("verifyPow rejects a challenge with a wrong signature", async () => {
    const env = { TURNSTILE_SECRET: SECRET, RATE_LIMIT: makeKv() } as any;
    const req = new Request("https://x/", { method: "POST" });
    const payload = base64Url(new TextEncoder().encode(JSON.stringify({ nonce: "n", exp: Date.now() + 1_000, ipTag: "x" })));
    expect(await verifyPow(req, env, `${payload}.AAAA`, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session / IP quota + burst
// ---------------------------------------------------------------------------

describe("session quota", () => {
  it("allows under limit and blocks at limit", async () => {
    expect(await checkSessionLimit(makeKv(), "s1")).toEqual({ allowed: true, remaining: DAILY_LIMIT });
    const full = makeKv({ [sessionLimitKey("s2")]: String(DAILY_LIMIT) });
    expect(await checkSessionLimit(full, "s2")).toEqual({ allowed: false, remaining: 0 });
  });

  it("increment persists across calls and decrements remaining", async () => {
    const kv = makeKv();
    expect(await incrementSessionLimit(kv, "s1")).toBe(DAILY_LIMIT - 1);
    expect(await incrementSessionLimit(kv, "s1")).toBe(DAILY_LIMIT - 2);
  });
});

describe("IP quota + burst", () => {
  it("allows under limit and blocks at limit", async () => {
    expect(await checkRateLimit(makeKv(), "1.2.3.4")).toEqual({ allowed: true, remaining: DAILY_LIMIT });
    const full = makeKv({ [getTodayKey("1.2.3.4")]: String(DAILY_LIMIT) });
    expect(await checkRateLimit(full, "1.2.3.4")).toEqual({ allowed: false, remaining: 0 });
  });

  it("incrementRateLimit / getRemainingQuota reflect consumption", async () => {
    const kv = makeKv();
    expect(await getRemainingQuota(kv, "ip")).toBe(DAILY_LIMIT);
    expect(await incrementRateLimit(kv, "ip")).toBe(DAILY_LIMIT - 1);
    expect(await getRemainingQuota(kv, "ip")).toBe(DAILY_LIMIT - 1);
  });

  it("IP and session quotas are independent (spec item 5)", async () => {
    const kv = makeKv();
    await incrementSessionLimit(kv, "sid");
    await incrementSessionLimit(kv, "sid");
    expect((await checkSessionLimit(kv, "sid")).remaining).toBe(DAILY_LIMIT - 2);
    // session consumption does not touch IP quota
    expect(await checkRateLimit(kv, "1.1.1.1")).toEqual({ allowed: true, remaining: DAILY_LIMIT });
    // a different session id has full quota (session quota is per-sid, not global)
    expect(await checkSessionLimit(kv, "other")).toEqual({ allowed: true, remaining: DAILY_LIMIT });
  });

  it("burst allows under limit and blocks at limit with retryAfter", async () => {
    expect(await checkBurst(makeKv(), "ip1")).toEqual({ allowed: true });
    const bucket = Math.floor(Date.now() / (BURST_WINDOW_SECONDS * 1000));
    const full = makeKv({ [`burst:ip2:${bucket}`]: String(BURST_LIMIT) });
    const blocked = await checkBurst(full, "ip2");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(BURST_WINDOW_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap endpoint (server-side Turnstile → signed session)
// ---------------------------------------------------------------------------

describe("bootstrap endpoint", () => {
  it("issues a trusted session after successful turnstile verification", async () => {
    const env = { TURNSTILE_SECRET: SECRET } as any;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));

    const req = new Request("https://ukiyo.openclawd.co/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken: "valid-token" }),
    });
    const res = await handleSessionBootstrap(req, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; expiresAt: number };
    expect(body.ok).toBe(true);

    const setCookie = res.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");

    const cookieValue = setCookie.split(";")[0].slice(SESSION_COOKIE.length + 1);
    expect(await verifyTrustedSession(reqWithCookie(cookieValue), SECRET)).not.toBeNull();
  });

  it("rejects a failed turnstile token", async () => {
    const env = { TURNSTILE_SECRET: SECRET } as any;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));

    const req = new Request("https://ukiyo.openclawd.co/api/session", {
      method: "POST",
      body: JSON.stringify({ turnstileToken: "bad" }),
    });
    const res = await handleSessionBootstrap(req, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "verification_failed" });
  });

  it("rejects an invalid JSON body with 400", async () => {
    const env = { TURNSTILE_SECRET: SECRET } as any;
    const req = new Request("https://ukiyo.openclawd.co/api/session", { method: "POST", body: "not-json" });
    const res = await handleSessionBootstrap(req, env);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Generate endpoint session gate
// ---------------------------------------------------------------------------

describe("generate session gate", () => {
  it("returns verification_required when no trusted session is present", async () => {
    const env = { TURNSTILE_SECRET: SECRET } as any;
    const req = new Request("https://ukiyo.openclawd.co/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "a tiger in the rain" }),
    });
    const res = await handleGenerate(req, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "verification_required" });
  });

  it("reaches the queue with a valid session and forwards its session id", async () => {
    const { value, session } = await issueTrustedSession(SECRET);
    let capturedSessionId: string | undefined;
    const genQueue = makeDoQueue((body) => {
      capturedSessionId = body.sessionId;
      return new Response(JSON.stringify({ taskId: "task_test", position: 1 }), { status: 202 });
    });
    const env = { TURNSTILE_SECRET: SECRET, RATE_LIMIT: makeKv(), GENERATION_QUEUE: genQueue } as any;

    const req = new Request("https://ukiyo.openclawd.co/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${value}` },
      body: JSON.stringify({ description: "a tiger in the rain" }),
    });
    const res = await handleGenerate(req, env);

    expect(res.status).toBe(202);
    expect(capturedSessionId).toBe(session.sid);
  });

  it("returns rate_limited when the IP daily quota is exhausted", async () => {
    const { value } = await issueTrustedSession(SECRET);
    const kv = makeKv({ [getTodayKey("unknown")]: String(DAILY_LIMIT) });
    const env = { TURNSTILE_SECRET: SECRET, RATE_LIMIT: kv } as any;
    const req = new Request("https://ukiyo.openclawd.co/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${value}` },
      body: JSON.stringify({ description: "a tiger in the rain" }),
    });
    const res = await handleGenerate(req, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("returns rate_limited when the session daily quota is exhausted", async () => {
    const { value, session } = await issueTrustedSession(SECRET);
    const kv = makeKv({ [sessionLimitKey(session.sid)]: String(DAILY_LIMIT) });
    const env = { TURNSTILE_SECRET: SECRET, RATE_LIMIT: kv } as any;
    const req = new Request("https://ukiyo.openclawd.co/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${value}` },
      body: JSON.stringify({ description: "a tiger in the rain" }),
    });
    const res = await handleGenerate(req, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });
});