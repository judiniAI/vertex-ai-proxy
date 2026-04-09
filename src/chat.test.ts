import { describe, it, expect } from "vitest";
import { mapReasoningEffort, openaiToVertex, sanitizeSchema, ensureResponseObject } from "./chat";
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
