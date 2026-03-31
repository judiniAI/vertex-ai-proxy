import { Env } from "./types";
import { handleChatCompletions } from "./chat";

const MODELS = [
  { id: "gemini-3.1-pro-preview",        object: "model", owned_by: "google" },
  { id: "gemini-3.1-flash-lite-preview",  object: "model", owned_by: "google" },
  { id: "gemini-2.5-pro",                object: "model", owned_by: "google" },
  { id: "gemini-2.5-flash",              object: "model", owned_by: "google" },
  { id: "gemini-2.5-flash-lite",         object: "model", owned_by: "google" },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (pathname === "/" || pathname === "/health") {
      return json({ status: "ok", service: "vertex-ai-gateway" });
    }

    // Auth
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token || token !== env.API_KEY) {
      return json({ error: { message: "Invalid or missing API key. Use Authorization: Bearer <key>.", type: "auth" } }, 401);
    }

    // List models
    if ((pathname === "/v1/models" || pathname === "/models") && request.method === "GET") {
      return json({ object: "list", data: MODELS });
    }

    // Chat completions
    if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
      if (request.method !== "POST") {
        return json({ error: { message: "Method not allowed. Use POST.", type: "error" } }, 405);
      }
      return handleChatCompletions(request, env, ctx);
    }

    return json({
      error: { message: "Not found. Available: GET /v1/models, POST /v1/chat/completions", type: "error" },
    }, 404);
  },
} satisfies ExportedHandler<Env>;
