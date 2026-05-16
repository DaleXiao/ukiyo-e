// SPEC-163 / T-273 unit test: 验证 LLM API gateway cutover 的关键不变量
//
// 必跑断言（spec §验收 §1）：
//   - URL 走 ${LLM_GATEWAY_URL}/v1/chat/completions  和  /v1/images/generations
//   - Authorization header == `Bearer ${LLM_SERVICE_TOKEN}`
//   - 401  → 不 retry，立即 throw
//   - 429  → retry once（再失败则按现有 backoff 多次，下一轮 200 应正常返回）
//   - 5xx  → retry once（同 429 语义）
//   - 200  → 不 retry

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  synthesizePrompt,
  generateIcon,
  CHAT_PATH,
  IMAGE_PATH,
} from "../src/index";

const GATEWAY = "https://api-llm.openclawd.co";
const TOKEN = "test-llm-service-token-xyz";

function chatOk(content: string) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content,
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function imageOk(url: string) {
  return new Response(
    JSON.stringify({
      output: {
        choices: [
          {
            message: {
              content: [{ image: url }],
            },
          },
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// synthesizePrompt 内部用 JSON.parse 提取 5 个 slot；为通过 assemblePrompt
// 验证，我们让 chat 返回一个合法的 JSON 结构。
const VALID_CHAT_JSON = JSON.stringify({
  master: "ukiyo-e",
  subject: "tiger in tall grass",
  composition: "low angle, centered",
  light: "golden hour rim light",
  palette: "warm earth tones",
  mood: "majestic stillness",
});

describe("SPEC-163 LLM gateway: URL + auth invariants", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("synthesizePrompt fetches ${GATEWAY}${CHAT_PATH} with Bearer LLM_SERVICE_TOKEN", async () => {
    const fetchMock = vi.fn(async (_url: any, _init: any) =>
      chatOk(VALID_CHAT_JSON),
    );
    vi.stubGlobal("fetch", fetchMock);

    await synthesizePrompt("a tiger", "ukiyo-e" as any, TOKEN, GATEWAY).catch(
      () => {},
    );

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GATEWAY}${CHAT_PATH}`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBe("POST");
  });

  it("generateIcon fetches ${GATEWAY}${IMAGE_PATH} with Bearer LLM_SERVICE_TOKEN", async () => {
    const fetchMock = vi.fn(async () =>
      imageOk("https://cdn.example/img.png"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateIcon("prompt", TOKEN, GATEWAY, 1);
    expect(result).toBe("https://cdn.example/img.png");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GATEWAY}${IMAGE_PATH}`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("SPEC-163 LLM gateway: retry classification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it("401 → 不 retry，立即 throw (generateIcon)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateIcon("p", TOKEN, GATEWAY, 5)).rejects.toThrow(
      /unauthorized/i,
    );
    // 一次性 throw，不应进入第二次循环
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 → 不 retry，立即 throw (synthesizePrompt)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      synthesizePrompt("a tiger", "ukiyo-e" as any, TOKEN, GATEWAY),
    ).rejects.toThrow(/unauthorized/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 → retry then succeed (generateIcon)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return imageOk("https://cdn.example/ok.png");
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = generateIcon("p", TOKEN, GATEWAY, 3);
    // 推进 backoff timer
    await vi.runAllTimersAsync();
    const out = await p;

    expect(out).toBe("https://cdn.example/ok.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("502/503 → retry then succeed (generateIcon)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return new Response("bad gw", { status: 502 });
      if (call === 2) return new Response("unavail", { status: 503 });
      return imageOk("https://cdn.example/after-5xx.png");
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = generateIcon("p", TOKEN, GATEWAY, 5);
    await vi.runAllTimersAsync();
    const out = await p;

    expect(out).toBe("https://cdn.example/after-5xx.png");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("200 → 不 retry (generateIcon)", async () => {
    const fetchMock = vi.fn(async () => imageOk("https://cdn.example/x.png"));
    vi.stubGlobal("fetch", fetchMock);

    await generateIcon("p", TOKEN, GATEWAY, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
