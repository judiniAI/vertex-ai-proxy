import { describe, it, expect, vi } from "vitest";
import {
  mapReasoningEffort,
  openaiToVertex,
  sanitizeSchema,
  ensureResponseObject,
  parseRetryInfoSeconds,
  buildRegionChain,
  jitteredBackoffMs,
  fetchGeminiWithFallback,
  GEMINI_FALLBACK_REGIONS,
} from "./chat";
import { OpenAIChatRequest, ReasoningEffort } from "./types";

// --- mapReasoningEffort ---

describe("mapReasoningEffort", () => {
  describe("Gemini 2.5 Flash (thinkingBudget)", () => {
    const model = "gemini-2.5-flash";

    it("maps 'none' to thinkingBudget 0", () => {
      expect(mapReasoningEffort("none", model)).toEqual({ thinkingBudget: 0 });
    });

    it("maps 'minimal' to thinkingBudget 128", () => {
      expect(mapReasoningEffort("minimal", model)).toEqual({ thinkingBudget: 128 });
    });

    it("maps 'low' to thinkingBudget 1024", () => {
      expect(mapReasoningEffort("low", model)).toEqual({ thinkingBudget: 1024 });
    });

    it("maps 'medium' to thinkingBudget 8192", () => {
      expect(mapReasoningEffort("medium", model)).toEqual({ thinkingBudget: 8192 });
    });

    it("maps 'high' to thinkingBudget -1 (dynamic)", () => {
      expect(mapReasoningEffort("high", model)).toEqual({ thinkingBudget: -1 });
    });
  });

  describe("Gemini 2.5 Pro (thinkingBudget, min 128)", () => {
    const model = "gemini-2.5-pro";

    it("maps 'none' to thinkingBudget 128 (cannot disable thinking)", () => {
      expect(mapReasoningEffort("none", model)).toEqual({ thinkingBudget: 128 });
    });

    it("maps 'minimal' to thinkingBudget 128", () => {
      expect(mapReasoningEffort("minimal", model)).toEqual({ thinkingBudget: 128 });
    });

    it("maps 'low' to thinkingBudget 1024", () => {
      expect(mapReasoningEffort("low", model)).toEqual({ thinkingBudget: 1024 });
    });

    it("maps 'high' to thinkingBudget -1 (dynamic)", () => {
      expect(mapReasoningEffort("high", model)).toEqual({ thinkingBudget: -1 });
    });
  });

  describe("Gemini 2.5 Flash-Lite (thinkingBudget, min 512 when on)", () => {
    const model = "gemini-2.5-flash-lite";

    it("maps 'none' to thinkingBudget 0 (can disable thinking)", () => {
      expect(mapReasoningEffort("none", model)).toEqual({ thinkingBudget: 0 });
    });

    it("maps 'minimal' to thinkingBudget 512 (min when on)", () => {
      expect(mapReasoningEffort("minimal", model)).toEqual({ thinkingBudget: 512 });
    });

    it("maps 'low' to thinkingBudget 1024", () => {
      expect(mapReasoningEffort("low", model)).toEqual({ thinkingBudget: 1024 });
    });

    it("maps 'high' to thinkingBudget -1 (dynamic)", () => {
      expect(mapReasoningEffort("high", model)).toEqual({ thinkingBudget: -1 });
    });
  });

  describe("Gemini 3.x Flash/Flash-Lite (thinkingLevel, supports minimal)", () => {
    const model = "gemini-3.1-flash-lite-preview";

    it("maps 'none' to thinkingLevel 'minimal'", () => {
      expect(mapReasoningEffort("none", model)).toEqual({ thinkingLevel: "minimal" });
    });

    it("maps 'minimal' to thinkingLevel 'minimal'", () => {
      expect(mapReasoningEffort("minimal", model)).toEqual({ thinkingLevel: "minimal" });
    });

    it("maps 'low' to thinkingLevel 'low'", () => {
      expect(mapReasoningEffort("low", model)).toEqual({ thinkingLevel: "low" });
    });

    it("maps 'medium' to thinkingLevel 'medium'", () => {
      expect(mapReasoningEffort("medium", model)).toEqual({ thinkingLevel: "medium" });
    });

    it("maps 'high' to thinkingLevel 'high'", () => {
      expect(mapReasoningEffort("high", model)).toEqual({ thinkingLevel: "high" });
    });

    it("works with gemini-3-flash-preview", () => {
      expect(mapReasoningEffort("high", "gemini-3-flash-preview")).toEqual({ thinkingLevel: "high" });
    });
  });

  describe("Gemini 3.x Pro (thinkingLevel, min 'low')", () => {
    const model = "gemini-3.1-pro-preview";

    it("maps 'none' to thinkingLevel 'low' (minimal not supported)", () => {
      expect(mapReasoningEffort("none", model)).toEqual({ thinkingLevel: "low" });
    });

    it("maps 'minimal' to thinkingLevel 'low' (minimal not supported)", () => {
      expect(mapReasoningEffort("minimal", model)).toEqual({ thinkingLevel: "low" });
    });

    it("maps 'low' to thinkingLevel 'low'", () => {
      expect(mapReasoningEffort("low", model)).toEqual({ thinkingLevel: "low" });
    });

    it("maps 'medium' to thinkingLevel 'medium'", () => {
      expect(mapReasoningEffort("medium", model)).toEqual({ thinkingLevel: "medium" });
    });

    it("maps 'high' to thinkingLevel 'high'", () => {
      expect(mapReasoningEffort("high", model)).toEqual({ thinkingLevel: "high" });
    });
  });

  describe("edge cases", () => {
    it("treats gemini-2.0-flash as non-3.x and non-pro (thinkingBudget 0)", () => {
      expect(mapReasoningEffort("none", "gemini-2.0-flash")).toEqual({ thinkingBudget: 0 });
    });
  });
});

// --- openaiToVertex: reasoning_effort integration ---

describe("openaiToVertex", () => {
  function makeRequest(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
    return {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hello" }],
      ...overrides,
    };
  }

  it("does not include thinkingConfig when reasoning_effort is omitted", () => {
    const result = openaiToVertex(makeRequest());
    expect(result.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it("includes thinkingBudget for gemini-2.5-flash with reasoning_effort=none", () => {
    const result = openaiToVertex(makeRequest({ reasoning_effort: "none" }));
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("includes thinkingBudget for gemini-2.5-flash with reasoning_effort=high", () => {
    const result = openaiToVertex(makeRequest({ reasoning_effort: "high" }));
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it("includes thinkingLevel for gemini-3.1 with reasoning_effort=low", () => {
    const result = openaiToVertex(makeRequest({
      model: "gemini-3.1-flash-lite-preview",
      reasoning_effort: "low",
    }));
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("includes thinkingLevel for gemini-3.1-pro with reasoning_effort=none (min 'low')", () => {
    const result = openaiToVertex(makeRequest({
      model: "gemini-3.1-pro-preview",
      reasoning_effort: "none",
    }));
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("combines reasoning_effort with other generationConfig params", () => {
    const result = openaiToVertex(makeRequest({
      temperature: 0.5,
      max_tokens: 1024,
      reasoning_effort: "medium",
    }));
    expect(result.generationConfig).toEqual({
      temperature: 0.5,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 8192 },
    });
  });

  it("still creates generationConfig when only reasoning_effort is set", () => {
    const result = openaiToVertex(makeRequest({ reasoning_effort: "low" }));
    expect(result.generationConfig).toBeDefined();
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 1024 });
  });

  it("maps all effort levels correctly for 2.5-flash", () => {
    const levels: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    const expected = [0, 128, 1024, 8192, -1];

    levels.forEach((level, i) => {
      const result = openaiToVertex(makeRequest({ reasoning_effort: level }));
      expect(result.generationConfig?.thinkingConfig?.thinkingBudget).toBe(expected[i]);
    });
  });

  it("maps all effort levels correctly for 2.5-pro (min 128)", () => {
    const levels: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    const expected = [128, 128, 1024, 8192, -1];

    levels.forEach((level, i) => {
      const result = openaiToVertex(makeRequest({ model: "gemini-2.5-pro", reasoning_effort: level }));
      expect(result.generationConfig?.thinkingConfig?.thinkingBudget).toBe(expected[i]);
    });
  });

  it("maps all effort levels correctly for 2.5-flash-lite (min 512 when on)", () => {
    const levels: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    const expected = [0, 512, 1024, 8192, -1];

    levels.forEach((level, i) => {
      const result = openaiToVertex(makeRequest({ model: "gemini-2.5-flash-lite", reasoning_effort: level }));
      expect(result.generationConfig?.thinkingConfig?.thinkingBudget).toBe(expected[i]);
    });
  });

  it("maps all effort levels correctly for 3.x flash-lite", () => {
    const levels: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    const expectedLevels = ["minimal", "minimal", "low", "medium", "high"];

    levels.forEach((level, i) => {
      const result = openaiToVertex(makeRequest({
        model: "gemini-3.1-flash-lite-preview",
        reasoning_effort: level,
      }));
      expect(result.generationConfig?.thinkingConfig?.thinkingLevel).toBe(expectedLevels[i]);
    });
  });

  it("maps all effort levels correctly for 3.x pro (min 'low')", () => {
    const levels: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    const expectedLevels = ["low", "low", "low", "medium", "high"];

    levels.forEach((level, i) => {
      const result = openaiToVertex(makeRequest({
        model: "gemini-3.1-pro-preview",
        reasoning_effort: level,
      }));
      expect(result.generationConfig?.thinkingConfig?.thinkingLevel).toBe(expectedLevels[i]);
    });
  });
});

// --- sanitizeSchema ---

describe("sanitizeSchema", () => {
  it("strips unsupported keys", () => {
    const result = sanitizeSchema({
      type: "object",
      additionalProperties: false,
      default: "foo",
      title: "MySchema",
      $ref: "#/defs/x",
      properties: { name: { type: "string" } },
    });
    expect(result.additionalProperties).toBeUndefined();
    expect(result.default).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(result.$ref).toBeUndefined();
    expect(result.type).toBe("OBJECT");
  });

  it("converts types to uppercase", () => {
    expect(sanitizeSchema({ type: "string" }).type).toBe("STRING");
    expect(sanitizeSchema({ type: "integer" }).type).toBe("INTEGER");
    expect(sanitizeSchema({ type: "array", items: { type: "number" } }).type).toBe("ARRAY");
  });

  it("handles [\"string\", \"null\"] → STRING + nullable", () => {
    const result = sanitizeSchema({ type: ["string", "null"] });
    expect(result.type).toBe("STRING");
    expect(result.nullable).toBe(true);
  });

  it("recursively sanitizes nested properties", () => {
    const result = sanitizeSchema({
      type: "object",
      properties: {
        address: {
          type: "object",
          title: "Address",
          additionalProperties: true,
          properties: { city: { type: "string", default: "NYC" } },
        },
      },
    });
    const address = result.properties as Record<string, Record<string, unknown>>;
    expect(address.address.title).toBeUndefined();
    expect(address.address.additionalProperties).toBeUndefined();
    expect(address.address.type).toBe("OBJECT");
    const city = (address.address.properties as Record<string, Record<string, unknown>>).city;
    expect(city.default).toBeUndefined();
    expect(city.type).toBe("STRING");
  });

  it("sanitizes items in arrays", () => {
    const result = sanitizeSchema({
      type: "array",
      items: { type: "string", title: "Item" },
    });
    const items = result.items as Record<string, unknown>;
    expect(items.title).toBeUndefined();
    expect(items.type).toBe("STRING");
  });
});

// --- ensureResponseObject ---

// --- parseRetryInfoSeconds ---

describe("parseRetryInfoSeconds", () => {
  it("extracts retryDelay from google.rpc.RetryInfo detail", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource exhausted",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "17s",
          },
        ],
      },
    });
    expect(parseRetryInfoSeconds(body)).toBe(17);
  });

  it("handles fractional seconds", () => {
    const body = JSON.stringify({
      error: {
        details: [{ "@type": "google.rpc.RetryInfo", retryDelay: "2.5s" }],
      },
    });
    expect(parseRetryInfoSeconds(body)).toBe(2.5);
  });

  it("handles array-wrapped error (streaming error format)", () => {
    const body = JSON.stringify([
      {
        error: {
          code: 429,
          details: [{ "@type": "google.rpc.RetryInfo", retryDelay: "10s" }],
        },
      },
    ]);
    expect(parseRetryInfoSeconds(body)).toBe(10);
  });

  it("returns null when no RetryInfo detail present", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "Resource exhausted",
        details: [{ "@type": "google.rpc.QuotaFailure", violations: [] }],
      },
    });
    expect(parseRetryInfoSeconds(body)).toBeNull();
  });

  it("returns null on non-JSON body", () => {
    expect(parseRetryInfoSeconds("not json at all")).toBeNull();
  });

  it("returns null on empty error", () => {
    expect(parseRetryInfoSeconds(JSON.stringify({}))).toBeNull();
  });

  it("ignores malformed retryDelay strings", () => {
    const body = JSON.stringify({
      error: {
        details: [{ "@type": "google.rpc.RetryInfo", retryDelay: "soon" }],
      },
    });
    expect(parseRetryInfoSeconds(body)).toBeNull();
  });
});

// --- buildRegionChain ---

describe("buildRegionChain", () => {
  it("starts with primary then appends all fallbacks in order", () => {
    const chain = buildRegionChain("global", false);
    expect(chain[0]).toBe("global");
    expect(chain.length).toBe(GEMINI_FALLBACK_REGIONS.length);
    expect(chain).toContain("us-east5");
    expect(chain).toContain("us-west4");
  });

  it("moves primary to front when it is not global", () => {
    const chain = buildRegionChain("us-east5", false);
    expect(chain[0]).toBe("us-east5");
    expect(chain).toContain("global");
    // No duplicates
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("returns only primary when respectExplicitRegion is true", () => {
    const chain = buildRegionChain("us-central1", true);
    expect(chain).toEqual(["us-central1"]);
  });

  it("handles primary not in fallback list by placing it first and keeping full list", () => {
    const chain = buildRegionChain("europe-west1", false);
    expect(chain[0]).toBe("europe-west1");
    expect(chain.length).toBe(GEMINI_FALLBACK_REGIONS.length + 1);
  });
});

// --- jitteredBackoffMs ---

describe("jitteredBackoffMs", () => {
  it("returns non-negative values", () => {
    for (let i = 0; i < 100; i++) {
      expect(jitteredBackoffMs(0)).toBeGreaterThanOrEqual(0);
    }
  });

  it("stays within the exponential cap", () => {
    for (let i = 0; i < 100; i++) {
      expect(jitteredBackoffMs(0)).toBeLessThanOrEqual(250);
      expect(jitteredBackoffMs(1)).toBeLessThanOrEqual(500);
      expect(jitteredBackoffMs(2)).toBeLessThanOrEqual(1000);
    }
  });

  it("caps at MAX_BACKOFF_MS regardless of high attempt numbers", () => {
    for (let i = 0; i < 100; i++) {
      expect(jitteredBackoffMs(10)).toBeLessThanOrEqual(2000);
    }
  });
});

// --- fetchGeminiWithFallback ---

describe("fetchGeminiWithFallback", () => {
  function mockResponse(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const baseOpts = {
    projectId: "test-project",
    model: "gemini-2.5-flash",
    token: "fake-token",
    requestBody: JSON.stringify({ contents: [] }),
    primaryRegion: "global",
    stream: false,
    respectExplicitRegion: false,
  };

  it("returns success on first attempt without touching fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true }));
    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(true);
    expect(result.regionUsed).toBe("global");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.attemptLog).toEqual(["global#0:ok"]);
  });

  it("retries on 429 within region then succeeds on second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(429, {
          error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource exhausted" },
        })
      )
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(true);
    expect(result.regionUsed).toBe("global");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attemptLog).toEqual(["global#0:429", "global#1:ok"]);
  });

  it("falls back to next region when primary is exhausted after retries", async () => {
    const errBody = {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource exhausted" },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, errBody))
      .mockResolvedValueOnce(mockResponse(429, errBody))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(true);
    expect(result.regionUsed).toBe("us-east5"); // next after global
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.attemptLog).toEqual([
      "global#0:429",
      "global#1:429",
      "us-east5#0:ok",
    ]);
  });

  it("skips region immediately when RetryInfo.retryDelay exceeds threshold", async () => {
    const longDelayErr = {
      error: {
        code: 429,
        message: "Resource exhausted",
        details: [{ "@type": "google.rpc.RetryInfo", retryDelay: "60s" }],
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, longDelayErr))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(true);
    expect(result.regionUsed).toBe("us-east5");
    // Should have exactly 2 calls: global (skipped early) + us-east5
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attemptLog).toContain("global:retryAfter=60s,skip-region");
  });

  it("propagates non-retryable 400 immediately without fallback", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(400, {
          error: { code: 400, status: "INVALID_ARGUMENT", message: "Bad schema" },
        })
      );

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(false);
    expect(result.response.status).toBe(400);
    expect(result.regionUsed).toBe("global");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates 401 immediately (auth failure is not retryable)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, { error: { code: 401, message: "Unauthorized" } }));
    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(false);
    expect(result.response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns final 429 with real status when all regions exhausted", async () => {
    const errBody = {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource exhausted" },
    };
    // Factory ensures every call returns a FRESH Response (body is single-read)
    const fetchImpl = vi.fn().mockImplementation(async () => mockResponse(429, errBody));

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(false);
    expect(result.response.status).toBe(429);
    expect(result.regionUsed).toBe("none");
    // 8 regions × 2 attempts each = 16 calls
    expect(fetchImpl).toHaveBeenCalledTimes(16);
  });

  it("does not fall back when respectExplicitRegion is true", async () => {
    const errBody = {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource exhausted" },
    };
    const fetchImpl = vi.fn().mockImplementation(async () => mockResponse(429, errBody));

    const result = await fetchGeminiWithFallback(
      { ...baseOpts, primaryRegion: "us-central1", respectExplicitRegion: true },
      fetchImpl as unknown as typeof fetch
    );

    expect(result.succeeded).toBe(false);
    expect(result.response.status).toBe(429);
    // Only 2 attempts in us-central1, no fallback to other regions
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and 504 (transient upstream failures)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(503, { error: { code: 503 } }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats network errors as retryable and falls back to next attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const result = await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    expect(result.succeeded).toBe(true);
    expect(result.attemptLog[0]).toContain("network:ECONNRESET");
  });

  it("builds correct URL for global endpoint (no region prefix)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true }));
    await fetchGeminiWithFallback(baseOpts, fetchImpl as unknown as typeof fetch);

    const calledUrl = (fetchImpl.mock.calls[0][0] as string);
    expect(calledUrl).toContain("https://aiplatform.googleapis.com");
    expect(calledUrl).toContain("/locations/global/");
    expect(calledUrl).toContain(":generateContent");
    expect(calledUrl).not.toContain("global-aiplatform");
  });

  it("builds correct URL for regional endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true }));
    await fetchGeminiWithFallback(
      { ...baseOpts, primaryRegion: "us-east5" },
      fetchImpl as unknown as typeof fetch
    );

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain("https://us-east5-aiplatform.googleapis.com");
    expect(calledUrl).toContain("/locations/us-east5/");
  });

  it("uses streamGenerateContent URL when stream=true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, "data: [DONE]\n\n"));
    await fetchGeminiWithFallback(
      { ...baseOpts, stream: true },
      fetchImpl as unknown as typeof fetch
    );

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain(":streamGenerateContent?alt=sse");
  });
});

describe("ensureResponseObject", () => {
  it("returns object as-is", () => {
    expect(ensureResponseObject({ foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("wraps array in { result }", () => {
    expect(ensureResponseObject([1, 2, 3])).toEqual({ result: [1, 2, 3] });
  });

  it("wraps string in { result }", () => {
    expect(ensureResponseObject("hello")).toEqual({ result: "hello" });
  });

  it("wraps number in { result }", () => {
    expect(ensureResponseObject(42)).toEqual({ result: 42 });
  });

  it("wraps null in { result }", () => {
    expect(ensureResponseObject(null)).toEqual({ result: null });
  });
});

// --- openaiToVertex: schema sanitization ---

describe("openaiToVertex schema sanitization", () => {
  function makeRequest(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
    return {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hello" }],
      ...overrides,
    };
  }

  it("sanitizes tool schemas and adds type OBJECT if missing", () => {
    const result = openaiToVertex(makeRequest({
      tools: [{ type: "function", function: { name: "test", parameters: { properties: { x: { type: "string" } } } } }],
    }));
    const params = result.tools![0].functionDeclarations[0].parameters!;
    expect(params.type).toBe("OBJECT");
  });

  it("strips additionalProperties from tool schemas", () => {
    const result = openaiToVertex(makeRequest({
      tools: [{
        type: "function",
        function: {
          name: "test",
          parameters: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
        },
      }],
    }));
    const params = result.tools![0].functionDeclarations[0].parameters!;
    expect(params.additionalProperties).toBeUndefined();
    expect(params.type).toBe("OBJECT");
  });

  it("omits parameters when empty", () => {
    const result = openaiToVertex(makeRequest({
      tools: [{ type: "function", function: { name: "test", parameters: {} } }],
    }));
    expect(result.tools![0].functionDeclarations[0].parameters).toBeUndefined();
  });
});
