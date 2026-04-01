import { describe, it, expect } from "vitest";
import { mapReasoningEffort, openaiToVertex } from "./chat";
import { OpenAIChatRequest, ReasoningEffort } from "./types";

// --- mapReasoningEffort ---

describe("mapReasoningEffort", () => {
  describe("Gemini 2.5 models (thinkingBudget)", () => {
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

    it("works with gemini-2.5-pro variant", () => {
      expect(mapReasoningEffort("low", "gemini-2.5-pro")).toEqual({ thinkingBudget: 1024 });
    });
  });

  describe("Gemini 3.x models (thinkingLevel)", () => {
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

    it("works with gemini-3.1-pro-preview", () => {
      expect(mapReasoningEffort("medium", "gemini-3.1-pro-preview")).toEqual({ thinkingLevel: "medium" });
    });

    it("works with gemini-3 base model", () => {
      expect(mapReasoningEffort("high", "gemini-3-flash")).toEqual({ thinkingLevel: "high" });
    });
  });

  describe("edge cases", () => {
    it("treats gemini-2.0-flash as non-3.x (thinkingBudget)", () => {
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

  it("includes thinkingLevel for gemini-3.1 with reasoning_effort=none", () => {
    const result = openaiToVertex(makeRequest({
      model: "gemini-3.1-pro-preview",
      reasoning_effort: "none",
    }));
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
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

  it("maps all effort levels correctly for 2.5 model", () => {
    const levels: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    const expected = [0, 128, 1024, 8192, -1];

    levels.forEach((level, i) => {
      const result = openaiToVertex(makeRequest({ reasoning_effort: level }));
      expect(result.generationConfig?.thinkingConfig?.thinkingBudget).toBe(expected[i]);
    });
  });

  it("maps all effort levels correctly for 3.x model", () => {
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
});
