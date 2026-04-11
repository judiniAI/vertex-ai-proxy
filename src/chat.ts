import {
  Env, OpenAIChatRequest, OpenAIChatResponse, OpenAIMessage, OpenAIToolCall,
  ReasoningEffort, VertexRequest, VertexResponse, VertexPart,
} from "./types";
import { getGCPAccessToken } from "./auth";

const MAX_STREAM_DURATION_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8192;
const GOOGLE_MODEL_PREFIXES = ["gemini-", "gemma-"];

// Retry + multi-region fallback for Gemini on DSQ 429.
// Order ranked by average error rate across three empirical stress runs
// (burst 30 / 100 / 600) from scripts/stress-regions.mjs. Lower is better:
//   global      2.57%   us-east5   67.83%   us-south1  76.17%
//   us-west4   88.90%   us-east1   89.67%   us-east4   90.27%
//   us-west1   91.23%   us-central1 93.00%
// Top 3 positions are stable across runs; positions 4-8 fluctuate under
// extreme load, but the overall ring guarantees we exhaust the
// high-headroom regions first before touching the weak ones.
export const GEMINI_FALLBACK_REGIONS = [
  "global",
  "us-east5",
  "us-south1",
  "us-west4",
  "us-east1",
  "us-east4",
  "us-west1",
  "us-central1",
] as const;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS_PER_REGION = 2;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;
const OVERALL_BUDGET_MS = 25_000;
const LONG_RETRY_THRESHOLD_SEC = 5;

// Keys not supported by Vertex AI schemas (OpenAPI 3.0 subset)
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "additionalProperties", "default", "title", "$ref",
  "oneOf", "anyOf", "allOf", "$schema", "$id",
]);

/** Strip unsupported schema properties and normalize types for Vertex AI */
export function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === "type") {
      // Handle ["string", "null"] → "STRING" + nullable
      if (Array.isArray(value)) {
        const types = (value as string[]).filter((t) => t !== "null");
        result.type = (types[0] || "string").toUpperCase();
        if ((value as string[]).includes("null")) result.nullable = true;
      } else if (typeof value === "string") {
        result.type = value.toUpperCase();
      } else {
        result.type = value;
      }
      continue;
    }

    if (key === "properties" && typeof value === "object" && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        if (typeof pv === "object" && pv !== null) {
          props[pk] = sanitizeSchema(pv as Record<string, unknown>);
        } else {
          props[pk] = pv;
        }
      }
      result.properties = props;
      continue;
    }

    if (key === "items" && typeof value === "object" && value !== null) {
      result.items = sanitizeSchema(value as Record<string, unknown>);
      continue;
    }

    result[key] = value;
  }

  return result;
}

/** Ensure functionResponse.response is always a JSON object (protobuf Struct) */
export function ensureResponseObject(data: unknown): Record<string, unknown> {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { result: data };
}

/** Resolve Vertex AI region: header > env > model-based default */
export function resolveRegion(request: Request, env: Env, model: string): string {
  const headerRegion = request.headers.get("x-vertex-region");
  if (headerRegion) return headerRegion;
  if (env.VERTEX_REGION) return env.VERTEX_REGION;
  // Gemini 3.x+ works on global, 2.5 needs a regional endpoint
  if (model.startsWith("gemini-3")) return "global";
  if (model.startsWith("gemini-2.5")) return "us-east1";
  return "global";
}

// Map OpenAI reasoning_effort to Vertex thinkingConfig based on model version
export function mapReasoningEffort(
  effort: ReasoningEffort, model: string
): { thinkingBudget?: number; thinkingLevel?: string } {
  const isGemini3 = model.startsWith("gemini-3");

  if (isGemini3) {
    // Gemini 3.x uses thinkingLevel
    // 3.1-pro-preview does not support "minimal", min is "low"
    const isProModel = model.includes("pro");
    const levelMap: Record<ReasoningEffort, string> = {
      none: isProModel ? "low" : "minimal",
      minimal: isProModel ? "low" : "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    };
    return { thinkingLevel: levelMap[effort] };
  }

  // Gemini 2.5 uses thinkingBudget (integer)
  // Pro: always on, min 128, max 32768
  // Flash: can disable, min 1, max 24576
  // Flash-Lite: can disable, min 512 when on, max 24576
  const isProModel = model.includes("2.5-pro");
  const isLiteModel = model.includes("flash-lite");

  const budgetMap: Record<ReasoningEffort, number> = {
    none: isProModel ? 128 : 0,
    minimal: isLiteModel ? 512 : 128,
    low: 1024,
    medium: 8192,
    high: -1,
  };
  return { thinkingBudget: budgetMap[effort] };
}

function isGeminiModel(model: string): boolean {
  return GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Full-jitter exponential backoff (AWS-style). */
export function jitteredBackoffMs(attempt: number): number {
  const cap = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * Math.pow(2, attempt));
  return Math.random() * cap;
}

/**
 * Parse google.rpc.RetryInfo.retryDelay from a Vertex error body.
 * Vertex does NOT set an HTTP Retry-After header; the hint lives in the
 * error payload under details[].retryDelay as a duration string like "53s".
 * Returns delay in seconds, or null if absent/unparseable.
 */
export function parseRetryInfoSeconds(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText);
    const errObj = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    const details = errObj?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
      const type = d?.["@type"];
      if (typeof type === "string" && type.includes("RetryInfo") && typeof d.retryDelay === "string") {
        const match = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (match) return parseFloat(match[1]);
      }
    }
  } catch {
    /* non-JSON body — nothing to parse */
  }
  return null;
}

/**
 * Build the ordered region chain: primary first, then every fallback region
 * in DSQ-headroom order (deduped). When respectExplicitRegion is true, returns
 * only the primary — caller opted out of fallback via header.
 */
export function buildRegionChain(
  primaryRegion: string,
  respectExplicitRegion: boolean
): string[] {
  if (respectExplicitRegion) return [primaryRegion];
  const chain = [primaryRegion];
  for (const r of GEMINI_FALLBACK_REGIONS) {
    if (r !== primaryRegion) chain.push(r);
  }
  return chain;
}

function buildGeminiUrl(
  projectId: string,
  region: string,
  model: string,
  stream: boolean
): string {
  const host =
    region === "global"
      ? "aiplatform.googleapis.com"
      : `${region}-aiplatform.googleapis.com`;
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `https://${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${action}`;
}

export interface FallbackResult {
  response: Response;
  regionUsed: string;
  attemptLog: string[];
  succeeded: boolean;
}

/**
 * Execute a Gemini request with per-region retry and cross-region fallback.
 * Contract:
 *   - Retries 408/429/5xx within a region up to MAX_ATTEMPTS_PER_REGION times.
 *   - Honors google.rpc.RetryInfo.retryDelay if ≤ LONG_RETRY_THRESHOLD_SEC;
 *     if server asks for a longer wait, skip straight to the next region.
 *   - Non-retryable errors (4xx except 408/429) are propagated immediately.
 *   - Wall-clock budget OVERALL_BUDGET_MS bounds the whole chain.
 *   - Successful responses are returned untouched so streaming works.
 *   - Error responses are returned with their ACTUAL status (not masked as 502)
 *     so callers can implement their own retry logic on the outer layer.
 */
export async function fetchGeminiWithFallback(
  opts: {
    projectId: string;
    model: string;
    token: string;
    requestBody: string;
    primaryRegion: string;
    stream: boolean;
    respectExplicitRegion: boolean;
  },
  fetchImpl: typeof fetch = fetch
): Promise<FallbackResult> {
  const startedAt = Date.now();
  const attemptLog: string[] = [];
  const regions = buildRegionChain(opts.primaryRegion, opts.respectExplicitRegion);

  let lastErrorBody: string | null = null;
  let lastErrorStatus = 0;
  let lastErrorHeaders: HeadersInit | undefined;

  outer: for (const region of regions) {
    if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
      attemptLog.push(`${region}:budget-exhausted`);
      break;
    }

    const url = buildGeminiUrl(opts.projectId, region, opts.model, opts.stream);

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_REGION; attempt++) {
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
        attemptLog.push(`${region}#${attempt}:budget-exhausted`);
        break outer;
      }

      if (attempt > 0) {
        await sleep(jitteredBackoffMs(attempt - 1));
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            "Content-Type": "application/json",
          },
          body: opts.requestBody,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        attemptLog.push(`${region}#${attempt}:network:${msg}`);
        // Treat network failure as retryable — fall through to next attempt
        continue;
      }

      if (response.ok) {
        attemptLog.push(`${region}#${attempt}:ok`);
        return { response, regionUsed: region, attemptLog, succeeded: true };
      }

      // Non-success: read body once so we can decide retry vs propagate
      const bodyText = await response.text();
      lastErrorBody = bodyText;
      lastErrorStatus = response.status;
      lastErrorHeaders = { "Content-Type": response.headers.get("content-type") ?? "application/json" };
      attemptLog.push(`${region}#${attempt}:${response.status}`);

      // Non-retryable: fail fast, propagate real status
      if (!RETRYABLE_STATUS.has(response.status)) {
        return {
          response: new Response(bodyText, {
            status: response.status,
            headers: lastErrorHeaders,
          }),
          regionUsed: region,
          attemptLog,
          succeeded: false,
        };
      }

      // Retryable: honor RetryInfo if present
      const retryAfterSec = parseRetryInfoSeconds(bodyText);
      if (retryAfterSec !== null && retryAfterSec > LONG_RETRY_THRESHOLD_SEC) {
        attemptLog.push(`${region}:retryAfter=${retryAfterSec}s,skip-region`);
        continue outer;
      }
      if (retryAfterSec !== null && retryAfterSec > 0) {
        await sleep(retryAfterSec * 1000);
      }
      // else: fall through to next attempt in this region
    }
  }

  // All regions exhausted — synthesize final error response with real status
  const finalStatus = lastErrorStatus || 502;
  const finalBody =
    lastErrorBody ??
    JSON.stringify({
      error: {
        message: "All Vertex AI regions failed or exceeded wall-clock budget.",
        type: "error",
      },
    });
  return {
    response: new Response(finalBody, {
      status: finalStatus,
      headers: lastErrorHeaders ?? { "Content-Type": "application/json" },
    }),
    regionUsed: "none",
    attemptLog,
    succeeded: false,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: { message, type: "error" } }, status);
}

export async function handleChatCompletions(
  request: Request, env: Env
): Promise<Response> {
  let body: OpenAIChatRequest;
  try {
    body = await request.json() as OpenAIChatRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body.");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "messages array is required and must not be empty.");
  }

  // Validate tool response count matches previous function calls
  for (let i = 1; i < body.messages.length; i++) {
    if (body.messages[i].role === "tool") {
      // Find the preceding assistant message with tool_calls
      let assistantIdx = i - 1;
      while (assistantIdx >= 0 && body.messages[assistantIdx].role === "tool") assistantIdx--;
      if (assistantIdx >= 0 && body.messages[assistantIdx].role === "assistant" && body.messages[assistantIdx].tool_calls) {
        const expectedCount = body.messages[assistantIdx].tool_calls!.length;
        let toolCount = 0;
        for (let j = assistantIdx + 1; j < body.messages.length && body.messages[j].role === "tool"; j++) toolCount++;
        if (toolCount !== expectedCount) {
          return errorResponse(400, `Tool response count (${toolCount}) does not match function call count (${expectedCount}). Vertex AI requires an exact match.`);
        }
      }
    }
  }

  const model = body.model || "gemini-2.0-flash";
  body.max_tokens = Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);

  const isGoogle = isGeminiModel(model);
  const token = await getGCPAccessToken(env.VERTEX_SERVICE_ACCOUNT_JSON);
  const region = resolveRegion(request, env, model);
  const hasExplicitRegionHeader = request.headers.get("x-vertex-region") != null;

  let response: Response;
  let regionUsed = region;
  let attemptLog: string[] = [];

  if (isGoogle) {
    const requestBody = JSON.stringify(openaiToVertex(body));
    const result = await fetchGeminiWithFallback({
      projectId: env.VERTEX_PROJECT_ID,
      model,
      token,
      requestBody,
      primaryRegion: region,
      stream: !!body.stream,
      // Respect explicit region pin — no fallback when caller specified region
      respectExplicitRegion: hasExplicitRegionHeader,
    });
    response = result.response;
    regionUsed = result.regionUsed;
    attemptLog = result.attemptLog;
  } else {
    // Non-Gemini models (Claude, Llama, etc.) use a different endpoint shape
    // that isn't supported in every region. Keep the single-shot path for them.
    const host =
      region === "global"
        ? "aiplatform.googleapis.com"
        : `${region}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${env.VERTEX_PROJECT_ID}/locations/${region}/endpoints/openapi/chat/completions`;
    const requestBody = JSON.stringify({
      model,
      messages: body.messages,
      ...(body.temperature != null && { temperature: body.temperature }),
      ...(body.max_tokens != null && { max_tokens: body.max_tokens }),
      ...(body.top_p != null && { top_p: body.top_p }),
      ...(body.stream != null && { stream: body.stream }),
      ...(body.tools && { tools: body.tools }),
      ...(body.tool_choice != null && { tool_choice: body.tool_choice }),
      ...(body.reasoning_effort != null && { reasoning_effort: body.reasoning_effort }),
    });
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: requestBody,
    });
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    let detail: string;
    try {
      const parsed = JSON.parse(upstreamBody);
      detail = parsed?.error?.message || parsed?.[0]?.error?.message || upstreamBody.slice(0, 500);
    } catch {
      detail = upstreamBody.slice(0, 500);
    }
    // Propagate the real upstream status (429/503/etc) so clients can do
    // their own outer retry. Include attempt log for observability.
    return json(
      {
        error: {
          message: `Upstream error ${response.status}: ${detail}`,
          type: "error",
          regions_tried: attemptLog.length > 0 ? attemptLog : undefined,
        },
      },
      response.status
    );
  }

  const successHeaders: Record<string, string> = { "X-Vertex-Region-Used": regionUsed };

  if (isGoogle) {
    if (body.stream) return handleGeminiStream(response, model, successHeaders);
    const vertexData = (await response.json()) as VertexResponse;
    return jsonWithHeaders(vertexToOpenai(vertexData, model), 200, successHeaders);
  } else {
    if (body.stream) return passthroughStream(response);
    const data = (await response.json()) as OpenAIChatResponse;
    return json(data);
  }
}

function jsonWithHeaders(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

// --- OpenAI <-> Vertex format conversion ---

export function openaiToVertex(body: OpenAIChatRequest): VertexRequest {
  const result: VertexRequest = { contents: [] };

  const systemMessages = body.messages.filter((m) => m.role === "system");
  if (systemMessages.length > 0) {
    result.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content || "").join("\n") }],
    };
  }

  let lastRole: string | null = null;

  for (const msg of body.messages) {
    if (msg.role === "system") continue;

    const vertexRole = msg.role === "assistant" ? "model" : "user";
    const parts: VertexPart[] = [];

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* skip */ }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      if (msg.content) parts.unshift({ text: msg.content });
    } else if (msg.role === "tool") {
      let parsed: unknown;
      try { parsed = JSON.parse(msg.content || "{}"); } catch { parsed = { output: msg.content || "" }; }
      const responseData = ensureResponseObject(parsed);
      parts.push({ functionResponse: { name: msg.name || msg.tool_call_id || "unknown", response: responseData } });
    } else {
      parts.push({ text: msg.content || "" });
    }

    const effectiveRole = msg.role === "tool" ? "user" : vertexRole;
    if (lastRole === effectiveRole && result.contents.length > 0) {
      result.contents[result.contents.length - 1].parts.push(...parts);
    } else {
      result.contents.push({ role: effectiveRole, parts });
      lastRole = effectiveRole;
    }
  }

  if (body.temperature != null || body.max_tokens != null || body.top_p != null || body.reasoning_effort != null) {
    result.generationConfig = {};
    if (body.temperature != null) result.generationConfig.temperature = body.temperature;
    if (body.max_tokens != null) result.generationConfig.maxOutputTokens = body.max_tokens;
    if (body.top_p != null) result.generationConfig.topP = body.top_p;
    if (body.reasoning_effort != null) {
      result.generationConfig.thinkingConfig = mapReasoningEffort(body.reasoning_effort, body.model || "gemini-2.0-flash");
    }
  }

  if (body.tools && body.tools.length > 0) {
    result.tools = [{
      functionDeclarations: body.tools.map((t) => {
        const decl: { name: string; description?: string; parameters?: Record<string, unknown> } = {
          name: t.function.name,
          description: t.function.description,
        };
        if (t.function.parameters && Object.keys(t.function.parameters).length > 0) {
          const sanitized = sanitizeSchema(t.function.parameters);
          if (!sanitized.type) sanitized.type = "OBJECT";
          decl.parameters = sanitized;
        }
        return decl;
      }),
    }];
  }

  if (body.tool_choice != null && body.tools && body.tools.length > 0) {
    if (body.tool_choice === "auto") {
      result.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    } else if (body.tool_choice === "none") {
      result.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (body.tool_choice === "required") {
      result.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    } else if (typeof body.tool_choice === "object" && body.tool_choice.function) {
      result.toolConfig = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [body.tool_choice.function.name] },
      };
    }
  }

  return result;
}

function vertexToOpenai(data: VertexResponse, model: string): OpenAIChatResponse {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const u = data.usageMetadata;

  const functionCalls = parts.filter((p) => p.functionCall);

  if (functionCalls.length > 0) {
    const toolCalls: OpenAIToolCall[] = functionCalls.map((p) => ({
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function" as const,
      function: {
        name: p.functionCall!.name,
        arguments: JSON.stringify(p.functionCall!.args || {}),
      },
    }));
    const textParts = parts.filter((p) => p.text).map((p) => p.text).join("");

    return {
      id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: textParts || null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: u?.promptTokenCount ?? 0, completion_tokens: u?.candidatesTokenCount ?? 0, total_tokens: u?.totalTokenCount ?? 0 },
    };
  }

  const text = parts.map((p) => p.text || "").join("");
  return {
    id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: u?.promptTokenCount ?? 0, completion_tokens: u?.candidatesTokenCount ?? 0, total_tokens: u?.totalTokenCount ?? 0 },
  };
}

// --- Streaming ---

function handleGeminiStream(
  response: Response,
  model: string,
  extraHeaders: Record<string, string> = {}
): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      let buffer = "";

      try {
        while (true) {
          if (Date.now() - startTime > MAX_STREAM_DURATION_MS) {
            const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "length" }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            reader.cancel();
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const vertexChunk: VertexResponse = JSON.parse(jsonStr);
              const parts = vertexChunk.candidates?.[0]?.content?.parts ?? [];

              const functionCalls = parts.filter((p) => p.functionCall);
              if (functionCalls.length > 0) {
                const toolCalls = functionCalls.map((p, i) => ({
                  index: i,
                  id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  type: "function" as const,
                  function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args || {}) },
                }));
                const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                continue;
              }

              const text = parts.map((p) => p.text || "").join("");
              if (!text) continue;

              const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch { /* skip malformed chunk */ }
          }
        }

        const finalChunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function passthroughStream(response: Response): Response {
  return new Response(response.body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" },
  });
}
