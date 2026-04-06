import {
  Env, OpenAIChatRequest, OpenAIChatResponse, OpenAIMessage, OpenAIToolCall,
  ReasoningEffort, VertexRequest, VertexResponse, VertexPart,
} from "./types";
import { getGCPAccessToken } from "./auth";

const MAX_STREAM_DURATION_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8192;
const GOOGLE_MODEL_PREFIXES = ["gemini-", "gemma-"];

// Map OpenAI reasoning_effort to Vertex thinkingConfig based on model version
export function mapReasoningEffort(
  effort: ReasoningEffort, model: string
): { thinkingBudget?: number; thinkingLevel?: string } {
  const isGemini3 = model.startsWith("gemini-3");

  if (isGemini3) {
    // Gemini 3.x uses thinkingLevel
    const levelMap: Record<ReasoningEffort, string> = {
      none: "minimal",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    };
    return { thinkingLevel: levelMap[effort] };
  }

  // Gemini 2.5 uses thinkingBudget (integer)
  const budgetMap: Record<ReasoningEffort, number> = {
    none: 0,
    minimal: 128,
    low: 1024,
    medium: 8192,
    high: -1,
  };
  return { thinkingBudget: budgetMap[effort] };
}

function isGeminiModel(model: string): boolean {
  return GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p));
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

  const model = body.model || "gemini-2.0-flash";
  body.max_tokens = Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);

  const isGoogle = isGeminiModel(model);
  const token = await getGCPAccessToken(env.VERTEX_SERVICE_ACCOUNT_JSON);
  const region = env.VERTEX_REGION || "global";
  const host = region === "global"
    ? "aiplatform.googleapis.com"
    : `${region}-aiplatform.googleapis.com`;

  let url: string;
  let requestBody: string;

  if (isGoogle) {
    const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    url = `https://${host}/v1/projects/${env.VERTEX_PROJECT_ID}/locations/${region}/publishers/google/models/${model}:${action}`;
    requestBody = JSON.stringify(openaiToVertex(body));
  } else {
    url = `https://${host}/v1/projects/${env.VERTEX_PROJECT_ID}/locations/${region}/endpoints/openapi/chat/completions`;
    requestBody = JSON.stringify({
      model,
      messages: body.messages,
      ...(body.temperature !== undefined && { temperature: body.temperature }),
      ...(body.max_tokens !== undefined && { max_tokens: body.max_tokens }),
      ...(body.top_p !== undefined && { top_p: body.top_p }),
      ...(body.stream !== undefined && { stream: body.stream }),
      ...(body.tools && { tools: body.tools }),
      ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
      ...(body.reasoning_effort !== undefined && { reasoning_effort: body.reasoning_effort }),
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: requestBody,
  });

  if (!response.ok) {
    const upstreamBody = await response.text();
    let detail: string;
    try {
      const parsed = JSON.parse(upstreamBody);
      detail = parsed?.error?.message || parsed?.[0]?.error?.message || upstreamBody.slice(0, 500);
    } catch {
      detail = upstreamBody.slice(0, 500);
    }
    return errorResponse(502, `Upstream error ${response.status}: ${detail}`);
  }

  if (isGoogle) {
    if (body.stream) return handleGeminiStream(response, model);
    const vertexData = await response.json() as VertexResponse;
    return json(vertexToOpenai(vertexData, model));
  } else {
    if (body.stream) return passthroughStream(response);
    const data = await response.json() as OpenAIChatResponse;
    return json(data);
  }
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
      let responseData: Record<string, unknown>;
      try { responseData = JSON.parse(msg.content || "{}"); } catch { responseData = { output: msg.content || "" }; }
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

  if (body.temperature !== undefined || body.max_tokens !== undefined || body.top_p !== undefined || body.reasoning_effort !== undefined) {
    result.generationConfig = {};
    if (body.temperature !== undefined) result.generationConfig.temperature = body.temperature;
    if (body.max_tokens !== undefined) result.generationConfig.maxOutputTokens = body.max_tokens;
    if (body.top_p !== undefined) result.generationConfig.topP = body.top_p;
    if (body.reasoning_effort !== undefined) {
      result.generationConfig.thinkingConfig = mapReasoningEffort(body.reasoning_effort, body.model || "gemini-2.0-flash");
    }
  }

  if (body.tools && body.tools.length > 0) {
    result.tools = [{
      functionDeclarations: body.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }];
  }

  if (body.tool_choice !== undefined && body.tools && body.tools.length > 0) {
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

function handleGeminiStream(response: Response, model: string): Response {
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
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" },
  });
}

function passthroughStream(response: Response): Response {
  return new Response(response.body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" },
  });
}
